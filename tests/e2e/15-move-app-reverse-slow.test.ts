/**
 * Phase 6 Task 12 — slow-path reverse-move E2E scenario.
 *
 * Drives the full forward saga to `completed` (REAL Neon logical replication),
 * then manually sets source_replica_state='none' to simulate a torn-down or
 * never-established replica, then calls /reverse. Asserts that:
 *   - The 202 response carries path='slow'
 *   - The saga driver picks up the swapped-direction migration
 *   - The reverse saga reaches current_step='completed'
 *   - user_app_index is back on the original region (us-east-1)
 */

// Must be set BEFORE any module that might fork pg_dump/psql resolves PATH.
process.env.PATH = `/opt/homebrew/opt/libpq/bin:${process.env.PATH ?? ''}`;

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import Redis from 'ioredis';
import { bootE2E, type E2EEnv } from './helpers/boot.js';
import { seedApp } from './helpers/seed.js';
import { cleanupAll } from './helpers/cleanup.js';
import { pollUntil } from './helpers/poll.js';
import { runtimePoolFor } from '../../services/control-api/src/services/runtime-pool-registry.js';
import { sseDispatcher } from '../../services/control-api/src/routes/hackathons-public.js';
import { buildE2ESagaCtx, runForwardMoveAppToCompleted } from './helpers/move-app-flow.js';
import { startMoveAppDriver } from '../../services/cron-scheduler/src/move-app-driver.js';
import { stepHandlers } from '../../services/control-api/src/services/move-app/step-registry.js';

const SRC_DATA_ADMIN_URI = 'postgresql://butterbase:butterbase_dev@localhost:5435/postgres';
const SRC_CUSTOMER_DB = 'cust_e2e_reverse_slow_source';
const SRC_CUSTOMER_URI = `postgresql://butterbase:butterbase_dev@localhost:5435/${SRC_CUSTOMER_DB}`;

let env: E2EEnv;
let sagaCtx: any = null;
let fwdDriverStop: (() => void) | null = null;
let revDriverStop: (() => void) | null = null;
let driverRedis: Redis | null = null;

async function ensureSourceCustomerDb(): Promise<void> {
  const admin = new pg.Pool({ connectionString: SRC_DATA_ADMIN_URI });
  try {
    const r = await admin.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM pg_database WHERE datname = $1`, [SRC_CUSTOMER_DB],
    );
    if (r.rows[0].c === 0) await admin.query(`CREATE DATABASE "${SRC_CUSTOMER_DB}"`);
  } finally { await admin.end(); }

  // Drop any leftover subscriptions from previous test runs.
  const cust = new pg.Pool({ connectionString: SRC_CUSTOMER_URI });
  try {
    const subs = await cust.query<{ subname: string }>(
      `SELECT subname FROM pg_subscription
         WHERE subname LIKE 'move_app_sub_%'
           AND subdbid = (SELECT oid FROM pg_database WHERE datname = current_database())`,
    );
    for (const { subname } of subs.rows) {
      await cust.query(`ALTER SUBSCRIPTION "${subname}" DISABLE`).catch(() => {});
      await cust.query(`ALTER SUBSCRIPTION "${subname}" SET (slot_name = NONE)`).catch(() => {});
      await cust.query(`DROP SUBSCRIPTION IF EXISTS "${subname}"`).catch(() => {});
    }
  } finally { await cust.end(); }
}

beforeAll(async () => {
  await ensureSourceCustomerDb();
  env = await bootE2E({ withDriver: false });
  sagaCtx = buildE2ESagaCtx(env);
  driverRedis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
}, 60_000);

afterAll(async () => {
  if (fwdDriverStop) fwdDriverStop();
  if (revDriverStop) revDriverStop();
  if (driverRedis) await driverRedis.quit();

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

describe('Phase 6 — slow-path reverse-move', () => {
  it('forward completes, source_replica_state forced to none, reverse uses slow path', async () => {
    const seeded = await seedApp(env.controlPool, { region: 'us-east-1' });

    // Seed source-side app_db_connections so the forward saga has a real DB to pg_dump.
    const srcRuntime = runtimePoolFor('us-east-1');
    await srcRuntime.query(
      `INSERT INTO app_db_connections (app_id, connection_string, neon_database_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (app_id) DO UPDATE SET connection_string = EXCLUDED.connection_string`,
      [seeded.appId, SRC_CUSTOMER_URI, SRC_CUSTOMER_DB],
    );

    // Run forward saga to completion (us-east-1 → eu-west-1).
    const { migrationId: fwdId, driverStop: stop } = await runForwardMoveAppToCompleted({
      env, seeded, destRegion: 'eu-west-1', sagaCtx, driverRedis: driverRedis!,
    });
    fwdDriverStop = stop;

    // Sanity check — forward really completed.
    const fwd = await env.controlPool.query<{ current_step: string; source_replica_state: string }>(
      `SELECT current_step, source_replica_state FROM app_migrations WHERE id = $1`, [fwdId],
    );
    expect(fwd.rows[0].current_step).toBe('completed');

    // Simulate "replica never set up / torn down" by forcing source_replica_state='none'.
    await env.controlPool.query(
      `UPDATE app_migrations SET source_replica_state = 'none' WHERE id = $1`, [fwdId],
    );

    // Start a new driver for the reverse saga.
    const revDriver = startMoveAppDriver({
      ctx: sagaCtx, redis: driverRedis!, handlers: stepHandlers, intervalMs: 500,
    });
    revDriverStop = revDriver.stop;

    // POST /reverse — should pick slow path.
    const r = await env.app.inject({
      method: 'POST',
      url: `/v1/apps/${seeded.appId}/migrations/${fwdId}/reverse`,
      payload: '{}',
      headers: { 'x-test-user-id': seeded.userId, 'content-type': 'application/json' },
    });
    if (r.statusCode !== 202) {
      throw new Error(`reverse expected 202 got ${r.statusCode}: ${r.body}`);
    }
    expect(r.json().path).toBe('slow');
    const revId = r.json().migrationId;

    // Poll until the slow-path saga completes (driver handles it like any forward move).
    const final = await pollUntil(async () => {
      const x = await env.controlPool.query<{ current_step: string; last_error: string | null }>(
        `SELECT current_step, last_error FROM app_migrations WHERE id = $1`, [revId],
      );
      const row = x.rows[0];
      if (!row) return null;
      if (row.current_step === 'failed') throw new Error(`slow-path reverse failed: ${row.last_error}`);
      if (row.current_step === 'completed') return row;
      return null;
    }, 150_000, 1_000);

    expect(final.current_step).toBe('completed');

    // Routing flipped back to us-east-1.
    const ix = await env.controlPool.query<{ region: string }>(
      `SELECT region FROM user_app_index WHERE app_id = $1`, [seeded.appId],
    );
    expect(ix.rows[0].region).toBe('us-east-1');
  }, 200_000);
});
