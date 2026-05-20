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

describe('Phase 5 — migration-guard plugin', () => {
  it('returns 503 + Retry-After=60 on write when apps.provisioning_status = migrating', async () => {
    const seeded = await seedApp(env.controlPool, { region: 'us-east-1' });
    // Mark the app as migrating in the runtime DB (us-east-1 = resolveLocalRegion() in E2E)
    await runtimePoolFor('us-east-1').query(
      `UPDATE apps SET provisioning_status = 'migrating' WHERE id = $1`,
      [seeded.appId],
    );
    // Flush the Redis cache so the plugin re-reads from DB
    await env.redis.del(`app-status:${seeded.appId}`);

    // POST /v1/:appId/durable-objects is tagged migrationGuard: true.
    // The guard runs at onRequest — before body parsing / auth — so even an
    // empty body triggers 503 before any 400/401 check.
    const r = await env.app.inject({
      method: 'POST', url: `/v1/${seeded.appId}/durable-objects`,
      payload: {},
      headers: { 'x-test-user-id': seeded.userId, 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(503);
    expect(r.headers['retry-after']).toBe('60');
  });

  it('GET still works (reads not blocked)', async () => {
    const seeded = await seedApp(env.controlPool, { region: 'us-east-1' });
    await runtimePoolFor('us-east-1').query(
      `UPDATE apps SET provisioning_status = 'migrating' WHERE id = $1`,
      [seeded.appId],
    );
    await env.redis.del(`app-status:${seeded.appId}`);

    // GET /v1/:appId/durable-objects is also tagged migrationGuard: true but
    // the plugin skips GET/HEAD/OPTIONS by design — so it must not be 503.
    const r = await env.app.inject({
      method: 'GET', url: `/v1/${seeded.appId}/durable-objects`,
      headers: { 'x-test-user-id': seeded.userId },
    });
    expect(r.statusCode).not.toBe(503);
  });
});
