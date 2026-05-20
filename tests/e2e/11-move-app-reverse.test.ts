/**
 * Phase 6 Task 10 — reverse-move fast path on top of REAL forward saga.
 *
 * Drives scenario 9's full forward saga to `completed` (REAL Neon logical
 * replication wired up between source and dest customer DBs), then POSTs
 * /reverse and asserts the routing returns to the original region.
 *
 * Requires `MOVE_APP_REPLICATION_ENABLED=true` (set in .env.e2e). With the
 * flag on, app.moveAppCtx exposes the REAL waitForReplicationCaughtUp +
 * promoteSourceToPrimary that runReverseMove invokes.
 */

// Must be set BEFORE any module that might fork pg_dump/psql resolves PATH.
process.env.PATH = `/opt/homebrew/opt/libpq/bin:${process.env.PATH ?? ''}`;

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import Redis from 'ioredis';
import { bootE2E, type E2EEnv } from './helpers/boot.js';
import { seedApp } from './helpers/seed.js';
import { cleanupAll } from './helpers/cleanup.js';
import { mockKv } from './helpers/mock-kv.js';
import { runtimePoolFor } from '../../services/control-api/src/services/runtime-pool-registry.js';
import { sseDispatcher } from '../../services/control-api/src/routes/hackathons-public.js';
import { buildE2ESagaCtx, runForwardMoveAppToCompleted } from './helpers/move-app-flow.js';

const SRC_DATA_ADMIN_URI = 'postgresql://butterbase:butterbase_dev@localhost:5435/postgres';
const SRC_CUSTOMER_DB = 'cust_e2e_reverse_source';
const SRC_CUSTOMER_URI = `postgresql://butterbase:butterbase_dev@localhost:5435/${SRC_CUSTOMER_DB}`;

let env: E2EEnv;
let sagaCtx: any = null;
let driverStop: (() => void) | null = null;
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
  if (driverStop) driverStop();
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

describe('Phase 6 — reverse-move on top of real forward saga', () => {
  it('forward then reverse: routing returns to original region', async () => {
    const seeded = await seedApp(env.controlPool, { region: 'us-east-1' });

    const srcRuntime = runtimePoolFor('us-east-1');
    await srcRuntime.query(
      `INSERT INTO app_db_connections (app_id, connection_string, neon_database_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (app_id) DO UPDATE SET connection_string = EXCLUDED.connection_string`,
      [seeded.appId, SRC_CUSTOMER_URI, SRC_CUSTOMER_DB],
    );

    const { migrationId: fwdId, driverStop: stop } = await runForwardMoveAppToCompleted({
      env, seeded, destRegion: 'eu-west-1', sagaCtx, driverRedis: driverRedis!,
    });
    driverStop = stop;

    // Sanity — forward really completed and replication is up.
    const fwd = await env.controlPool.query<{ source_replica_state: string }>(
      `SELECT source_replica_state FROM app_migrations WHERE id = $1`, [fwdId],
    );
    expect(fwd.rows[0].source_replica_state).toBe('replicating');

    // Now POST /reverse — runs against app.moveAppCtx with REAL waitForReplicationCaughtUp +
    // promoteSourceToPrimary (MOVE_APP_REPLICATION_ENABLED=true).
    const reverse = await env.app.inject({
      method: 'POST',
      url: `/v1/apps/${seeded.appId}/migrations/${fwdId}/reverse`,
      headers: { 'x-test-user-id': seeded.userId, 'content-type': 'application/json' },
      payload: '{}',
    });
    if (reverse.statusCode !== 202) {
      throw new Error(`reverse expected 202 got ${reverse.statusCode}: ${reverse.body}`);
    }

    // Routing flipped back
    const ix = await env.controlPool.query<{ region: string }>(
      `SELECT region FROM user_app_index WHERE app_id = $1`, [seeded.appId],
    );
    expect(ix.rows[0].region).toBe('us-east-1');

    // KV flipped back
    const kv = await mockKv.get(`sub:${seeded.subdomain}`);
    expect(kv).not.toBeNull();
    expect(JSON.parse(kv!).region).toBe('us-east-1');

    // Subscription dropped on source by promoteSourceToPrimary. NB:
    // pg_subscription is cluster-wide; filter by subdbid = current DB so we
    // don't see subscriptions owned by other test DBs in the same cluster.
    const srcPool = new pg.Pool({ connectionString: SRC_CUSTOMER_URI, max: 2 });
    try {
      const r = await srcPool.query<{ c: number }>(
        `SELECT count(*)::int AS c FROM pg_subscription
           WHERE subname LIKE 'move_app_sub_%'
             AND subdbid = (SELECT oid FROM pg_database WHERE datname = current_database())`,
      );
      expect(r.rows[0].c).toBe(0);
    } finally { await srcPool.end(); }
  }, 240_000);
});
