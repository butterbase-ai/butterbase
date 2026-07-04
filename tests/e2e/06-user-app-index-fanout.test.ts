/**
 * Phase 4 E2E — GET /apps org_app_index regional fan-out
 *
 * The /apps route (services/control-api/src/routes/init.ts) reads
 * org_app_index to determine which regions a user has apps in, then queries
 * ONLY those regions' runtime pools. This test verifies that fan-out actually
 * respects the index — apps in regions the user doesn't have entries for are
 * NOT returned, and apps from multiple regions ARE merged.
 *
 * Response shape: { apps: [{ id, name, subdomain, db_name, db_provisioned,
 *                            provisioning_status, region, created_at }, ...] }
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootE2E, type E2EEnv } from './helpers/boot.js';
import { seedApp } from './helpers/seed.js';
import { cleanupAll } from './helpers/cleanup.js';
import { runtimePoolFor } from '../../services/control-api/src/services/runtime-pool-registry.js';
import { sseDispatcher } from '../../services/control-api/src/routes/hackathons-public.js';

let env: E2EEnv;

beforeAll(async () => {
  env = await bootE2E();
}, 60_000);

afterAll(async () => {
  const appAny = env.app as any;
  const intervals = ['ragWorkerInterval', 'flushInterval', 'failureNotifierInterval',
    'neonWorkerInterval', 'analyticsPullerInterval', 'nightlyInterval'];
  const timeouts = ['nightlyTimeout'];
  for (const key of intervals) if (appAny[key]) { clearInterval(appAny[key]); appAny[key] = undefined; }
  for (const key of timeouts) if (appAny[key]) { clearTimeout(appAny[key]); appAny[key] = undefined; }
  sseDispatcher.stop();
  await cleanupAll(env.controlPool);
  await env.shutdown();
}, 120_000);

describe('Phase 4 — GET /apps fans out by org_app_index', () => {
  it('user with apps only in us-east-1 sees only us-east-1 results', async () => {
    const a = await seedApp(env.controlPool, { region: 'us-east-1', emailPrefix: 'fanout' });
    await seedApp(env.controlPool, { region: 'us-east-1', emailPrefix: 'fanout' });

    // Re-attach the second seeded app to the same user so we get two rows for the user.
    // Actually each seedApp creates its own user, so just hit /apps for user `a`
    // and assert only their own apps are returned and they're all us-east-1.
    const r = await env.app.inject({
      method: 'GET', url: '/apps',
      headers: { 'x-test-user-id': a.userId },
    });

    expect(r.statusCode).toBe(200);
    const body = r.json() as { apps: Array<{ id: string; region: string; owner_id?: string }> };
    expect(Array.isArray(body.apps)).toBe(true);
    expect(body.apps.length).toBeGreaterThanOrEqual(1);
    for (const app of body.apps) expect(app.region).toBe('us-east-1');
  });

  it('user with apps in both regions sees apps merged from both', async () => {
    const a = await seedApp(env.controlPool, { region: 'us-east-1', emailPrefix: 'fanout-multi' });

    // Seed a second app for the SAME user in eu-west-1 by hand.
    const stamp = `${Date.now()}_eu_${Math.random().toString(36).slice(2, 6)}`;
    const euAppId = `e2e-app-${stamp}`;
    await env.controlPool.query(
      `INSERT INTO org_app_index (app_id, organization_id, region) VALUES ($1, (SELECT personal_organization_id FROM platform_users WHERE id = $2), 'eu-west-1')`,
      [euAppId, a.userId],
    );
    const eu = runtimePoolFor('eu-west-1');
    await eu.query(
      `INSERT INTO apps (id, name, owner_id, db_name, subdomain, region, provisioning_status)
       VALUES ($1, 'eu app', $2, $3, $4, 'eu-west-1', 'ready')`,
      [euAppId, a.userId, `cust_eu_${stamp}`, `sub-${stamp}`],
    );

    const r = await env.app.inject({
      method: 'GET', url: '/apps',
      headers: { 'x-test-user-id': a.userId },
    });

    expect(r.statusCode).toBe(200);
    const body = r.json() as { apps: Array<{ id: string; region: string }> };
    const regions = new Set(body.apps.map((x) => x.region));
    expect(regions.has('us-east-1')).toBe(true);
    expect(regions.has('eu-west-1')).toBe(true);
  });
});
