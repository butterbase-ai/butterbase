/**
 * Phase 4 E2E — Fly-Replay cross-region routing
 *
 * Verifies that requests to routes tagged `requiresAppRegion: true` get a
 * `Fly-Replay: region=<dest>` header when the app's home region differs from
 * the local region (BUTTERBASE_REGION). Locally-homed apps are served without
 * a Fly-Replay header.
 *
 * The fly-replay plugin runs in an onRequest hook and:
 *   - 404s if resolveAppRegion() returns null
 *   - Sets `Fly-Replay: region=<dest>` and short-circuits the response when
 *     the app lives in a different region
 *   - Falls through to the route handler otherwise
 *
 * We pre-seed the redis cache key `app-region:<appId>` so resolveAppRegion
 * doesn't have to query the eu-west-1 runtime pool from us-east-1 (the local
 * runtime pool only contains us-east-1 apps).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootE2E, type E2EEnv } from './helpers/boot.js';
import { seedApp } from './helpers/seed.js';
import { cleanupAll } from './helpers/cleanup.js';
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

describe('Phase 4 — Fly-Replay on cross-region request', () => {
  it('returns Fly-Replay header when app lives in a different region', async () => {
    // BUTTERBASE_REGION in .env.e2e is us-east-1; seed the app in eu-west-1.
    const seeded = await seedApp(env.controlPool, { region: 'eu-west-1' });
    // Pre-seed redis app-region cache so the local runtime pool doesn't need
    // to be queried (the eu-west-1 app row only lives in the eu runtime pool).
    await env.redis.setex(`app-region:${seeded.appId}`, 300, 'eu-west-1');

    const r = await env.app.inject({
      method: 'GET',
      url: `/v1/${seeded.appId}/durable-objects`,
      headers: { 'x-test-user-id': seeded.userId },
    });

    expect(r.headers['fly-replay']).toBeDefined();
    expect(String(r.headers['fly-replay'])).toMatch(/region=eu-west-1/);
  });

  it('serves locally without Fly-Replay when app lives in the current region', async () => {
    const seeded = await seedApp(env.controlPool, { region: 'us-east-1' });

    const r = await env.app.inject({
      method: 'GET',
      url: `/v1/${seeded.appId}/durable-objects`,
      headers: { 'x-test-user-id': seeded.userId },
    });

    expect(r.headers['fly-replay']).toBeUndefined();
    // After Task 14 fix: listDurableObjects now routes to runtimeDb — local-region
    // app should get 200 with an empty list (no DOs seeded), not a 500 "relation does not exist".
    if (r.statusCode === 307) {
      // Cross-region replay (shouldn't happen for us-east-1 app, but guard defensively)
      expect(r.headers['fly-replay']).toMatch(/region=/);
    } else {
      expect(r.statusCode).toBe(200);
    }
  });
});
