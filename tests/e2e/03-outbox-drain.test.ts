/**
 * Phase 3 E2E — Outbox drain reconciles user_billing_state to runtime DBs
 *
 * The actual Phase 3 tables and functions (verified via grep):
 * - Control-plane:  user_state_outbox  (db/control-plane/062_user_state_outbox.sql)
 *   cols: id, user_id, fields_changed (jsonb), version (bigint), applied_to_regions (text[]),
 *         created_at, done_at
 * - Runtime-plane:  user_billing_state (db/runtime-plane/002_user_billing_state.sql)
 *   cols: user_id, plan_id, account_status, spending_cap_usd,
 *         topup_lease_remaining_usd, lease_expires_at, last_outbox_version, updated_at
 *
 * Drain function:  drainOnce(ctx: DrainContext) — services/control-api/src/services/state-outbox-drain.ts
 *   ctx = { platformPool, runtimePoolsByRegion }
 *   Reads pending user_state_outbox rows (FOR UPDATE SKIP LOCKED), fans out to
 *   each region's user_billing_state, marks done_at when all regions covered.
 *
 * Note: writeUserStateChange (state-outbox.ts) also updates platform_users in the
 * same tx.  For a self-contained seed we insert into user_state_outbox directly
 * (bypassing platform_users mutation) using the same shape the drain function
 * expects.  The drain only reads user_state_outbox — it does not read platform_users
 * again — so this is a valid end-to-end exercise of the drain mechanism.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootE2E, type E2EEnv } from './helpers/boot.js';
import { seedApp } from './helpers/seed.js';
import { cleanupAll } from './helpers/cleanup.js';
import { runtimePoolFor } from '../../services/control-api/src/services/runtime-pool-registry.js';
import {
  drainOnce,
  type DrainContext,
} from '../../services/control-api/src/services/state-outbox-drain.js';

let env: E2EEnv;

beforeAll(async () => {
  env = await bootE2E();
}, 60_000);

afterAll(async () => {
  await cleanupAll(env.controlPool);

  // Clear background intervals/timeouts that are NOT wired into app.close().
  // Without this the process stays open past the hook timeout (same pattern as
  // test 02 — see 02-orphan-cleanup.test.ts afterAll).
  const appAny = env.app as any;
  const intervals = [
    'ragWorkerInterval', 'flushInterval', 'failureNotifierInterval',
    'neonWorkerInterval', 'analyticsPullerInterval', 'nightlyInterval',
  ];
  const timeouts = ['nightlyTimeout'];
  for (const key of intervals) if (appAny[key]) { clearInterval(appAny[key]); appAny[key] = undefined; }
  for (const key of timeouts) if (appAny[key]) { clearTimeout(appAny[key]); appAny[key] = undefined; }

  // Release the SSE dispatcher's LISTEN client so pool.end() can complete.
  try {
    const { sseDispatcher } = await import('../../services/control-api/src/routes/hackathons-public.js');
    sseDispatcher.stop();
  } catch { /* optional */ }

  await env.shutdown();
}, 120_000);

describe('Phase 3 — outbox drain reconciles user_billing_state to runtime DBs', () => {
  it('writes to user_state_outbox (control-plane) and drainOnce fans it out to runtime user_billing_state', async () => {
    const seeded = await seedApp(env.controlPool, { region: 'us-east-1' });
    const runtimePool = runtimePoolFor('us-east-1');

    // Step 1 — Insert a pending outbox row on the control-plane.
    // fields_changed reflects the Phase 3 supported fields: account_status, plan_id, spending_cap_usd.
    // applied_to_regions starts empty so drainOnce will push to every configured region.
    const outboxInsert = await env.controlPool.query<{ id: number; version: string }>(
      `INSERT INTO user_state_outbox (user_id, fields_changed)
       VALUES ($1, $2::jsonb)
       RETURNING id, version`,
      [seeded.userId, JSON.stringify({ account_status: 'active', plan_id: 'launch' })],
    );
    expect(outboxInsert.rows).toHaveLength(1);
    const outboxId = outboxInsert.rows[0].id;

    // Step 2 — Build DrainContext with only the regions we have configured.
    const runtimePoolsByRegion: Record<string, ReturnType<typeof runtimePoolFor>> = {};
    for (const r of env.regions) {
      runtimePoolsByRegion[r] = runtimePoolFor(r);
    }
    const ctx: DrainContext = { platformPool: env.controlPool, runtimePoolsByRegion };

    // Step 3 — Run the drain. Returns { processed, errors }.
    const result = await drainOnce(ctx);
    expect(result.errors).toHaveLength(0);
    expect(result.processed).toBeGreaterThanOrEqual(1);

    // Step 4 — Verify the outbox row is now marked done (applied to all regions).
    const outboxAfter = await env.controlPool.query<{ done_at: Date | null; applied_to_regions: string[] }>(
      `SELECT done_at, applied_to_regions FROM user_state_outbox WHERE id = $1`,
      [outboxId],
    );
    expect(outboxAfter.rows[0].done_at).not.toBeNull();
    expect(outboxAfter.rows[0].applied_to_regions).toContain('us-east-1');

    // Step 5 — Verify the runtime user_billing_state row was written.
    const ubsRow = await runtimePool.query<{
      user_id: string;
      account_status: string | null;
      plan_id: string | null;
      last_outbox_version: string;
    }>(
      `SELECT user_id, account_status, plan_id, last_outbox_version
       FROM user_billing_state WHERE user_id = $1`,
      [seeded.userId],
    );
    expect(ubsRow.rows).toHaveLength(1);
    expect(ubsRow.rows[0].account_status).toBe('active');
    expect(ubsRow.rows[0].plan_id).toBe('launch');
    expect(parseInt(ubsRow.rows[0].last_outbox_version, 10)).toBeGreaterThan(0);
  });

  it('drainOnce is idempotent — re-running on an already-done outbox row is a no-op (processed=0)', async () => {
    // Insert a row that is already marked done and applied to all regions.
    const seeded = await seedApp(env.controlPool, { region: 'us-east-1' });

    await env.controlPool.query(
      `INSERT INTO user_state_outbox (user_id, fields_changed, applied_to_regions, done_at)
       VALUES ($1, $2::jsonb, $3, now())`,
      [
        seeded.userId,
        JSON.stringify({ plan_id: 'launch' }),
        env.regions,       // already applied to every region
      ],
    );

    const runtimePoolsByRegion: Record<string, ReturnType<typeof runtimePoolFor>> = {};
    for (const r of env.regions) runtimePoolsByRegion[r] = runtimePoolFor(r);
    const ctx: DrainContext = { platformPool: env.controlPool, runtimePoolsByRegion };

    // The pending query filters WHERE done_at IS NULL, so 0 rows should be fetched.
    const result = await drainOnce(ctx);
    expect(result.processed).toBe(0);
  });
});
