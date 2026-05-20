/**
 * Phase 4 E2E — /v1/internal/region-state admin endpoint
 *
 * Verifies that the region-state endpoint:
 *  - Returns per-region app counts when the correct internal secret is provided.
 *  - Returns 401 when the secret is missing.
 *
 * Auth: `x-butterbase-internal-secret` header (BUTTERBASE_INTERNAL_SECRET env var).
 * Route: GET /v1/internal/region-state (services/control-api/src/routes/admin/region-state.ts)
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
  // Mirror teardown pattern from 02-orphan-cleanup.test.ts:
  // Clear background intervals before pool shutdown to avoid "pool after end" errors.
  const appAny = env.app as any;
  const intervals = ['ragWorkerInterval', 'flushInterval', 'failureNotifierInterval',
    'neonWorkerInterval', 'analyticsPullerInterval', 'nightlyInterval'];
  const timeouts = ['nightlyTimeout'];
  for (const key of intervals) if (appAny[key]) { clearInterval(appAny[key]); appAny[key] = undefined; }
  for (const key of timeouts) if (appAny[key]) { clearTimeout(appAny[key]); appAny[key] = undefined; }

  // Release the SSE dispatcher's LISTEN client so pool.end() can complete.
  sseDispatcher.stop();

  await cleanupAll(env.controlPool);
  await env.shutdown();
}, 120_000);

describe('Phase 4 — /v1/internal/region-state', () => {
  it('returns per-region app counts with valid internal secret', async () => {
    await seedApp(env.controlPool, { region: 'us-east-1' });
    await seedApp(env.controlPool, { region: 'eu-west-1' });

    const r = await env.app.inject({
      method: 'GET',
      url: '/v1/internal/region-state',
      headers: {
        'x-butterbase-internal-secret': process.env.BUTTERBASE_INTERNAL_SECRET!,
      },
    });

    expect(r.statusCode).toBe(200);
    const body = r.json() as {
      platformRegion: string | null;
      localRegion: string | null;
      configuredRegions: string[];
      appCountByRegion: Record<string, number>;
      unknownRegions: Array<{ region: string; appCount: number }>;
    };

    expect(body).toBeDefined();
    expect(body.configuredRegions).toBeInstanceOf(Array);
    expect(body.appCountByRegion).toBeDefined();
    // The seeded apps should appear in their respective regions.
    expect(body.appCountByRegion['us-east-1']).toBeGreaterThanOrEqual(1);
    expect(body.appCountByRegion['eu-west-1']).toBeGreaterThanOrEqual(1);
  });

  it('returns 401 without internal secret', async () => {
    const r = await env.app.inject({
      method: 'GET',
      url: '/v1/internal/region-state',
    });

    expect(r.statusCode).toBe(401);
  });

  it('returns 401 with wrong internal secret', async () => {
    const r = await env.app.inject({
      method: 'GET',
      url: '/v1/internal/region-state',
      headers: { 'x-butterbase-internal-secret': 'totally-wrong-secret' },
    });

    expect(r.statusCode).toBe(401);
  });
});
