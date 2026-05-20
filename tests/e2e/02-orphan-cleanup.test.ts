/**
 * Phase 2 E2E — Cross-tier orphan detection (live databases)
 *
 * Verifies that detectCrossTierOrphans() finds rows in the control-plane DB
 * whose app_id no longer exists in any runtime DB.
 *
 * Schema note: the `subscriptions` table does NOT have an app_id column (only
 * user_id + plan_id). The `usage_meters` table DOES have app_id (nullable).
 * detectCrossTierOrphans() scans both tables via `WHERE app_id IS NOT NULL AND
 * app_id NOT IN (...)`, so we plant a phantom row in usage_meters to trigger
 * the orphan count reliably.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootE2E, type E2EEnv } from './helpers/boot.js';
import { seedApp } from './helpers/seed.js';
import { cleanupAll } from './helpers/cleanup.js';
import { runtimePoolFor } from '../../services/control-api/src/services/runtime-pool-registry.js';
import { detectCrossTierOrphans } from '../../services/control-api/src/services/orphan-cleanup.js';
import { sseDispatcher } from '../../services/control-api/src/routes/hackathons-public.js';

let env: E2EEnv;

beforeAll(async () => {
  env = await bootE2E();
}, 60_000);

afterAll(async () => {
  // Stop all background interval workers before closing pools.
  // These are started in a Promise.resolve(app.ready()).then() chain in index.ts
  // and are NOT wired into app.close(), so we clear them manually to avoid
  // "pool after end" errors and to prevent vitest from hanging on open handles.
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

describe('Phase 2 — orphan-cleanup cross-tier scan', () => {
  it('detects a usage_meter whose app_id has no row in any runtime DB', async () => {
    // Seed a real app so that at least one valid user exists to satisfy the FK.
    const seeded = await seedApp(env.controlPool, { region: 'us-east-1' });

    // Insert a phantom usage_meter that references a non-existent app_id.
    // usage_meters columns: id, user_id, app_id, meter_type, period_start, quantity
    await env.controlPool.query(
      `INSERT INTO usage_meters (user_id, app_id, meter_type, period_start, quantity)
       VALUES ($1, 'app-DOES-NOT-EXIST', 'api_calls', CURRENT_DATE, 0)`,
      [seeded.userId],
    );

    // Build runtimePoolsByRegion map for detectCrossTierOrphans()
    const runtimePoolsByRegion: Record<string, ReturnType<typeof runtimePoolFor>> = {};
    for (const r of env.regions) {
      runtimePoolsByRegion[r] = runtimePoolFor(r);
    }

    const counts = await detectCrossTierOrphans(env.controlPool, runtimePoolsByRegion);

    // The phantom meter must be counted
    expect(counts.usage_meters).toBeGreaterThanOrEqual(1);
  });
});
