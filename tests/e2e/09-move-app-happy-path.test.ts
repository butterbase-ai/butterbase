/**
 * Phase 6 Task 10 — move-app happy path us-east-1 → eu-west-1 with REAL Neon
 * logical replication.
 *
 * The full saga: requested → reserving_dest → blocking_writes → dumping_data →
 * restoring_data → copying_blobs → copying_runtime → flipping_routing →
 * setting_up_reverse_replication → unblocking_writes → completed.
 *
 * Local data plane = two Postgres-16 containers on the `butterbase` compose
 * bridge network (ports 5435/5436 on host, 5432 inside). Both have
 * wal_level=logical so CREATE PUBLICATION/SUBSCRIPTION is supported.
 *
 * `setting_up_reverse_replication` invokes the test-only
 * configureNeonReplicationE2E helper which runs the SAME SQL as production's
 * configureNeonReplication, but rewrites `localhost:5436` →
 * `butterbase-data-plane-db-eu-1:5432` when embedding the dest URI inside
 * CREATE SUBSCRIPTION (the source CONTAINER has to dial dest, and
 * `host.docker.internal` is not mapped on macOS hosts).
 *
 * Post-completion the test asserts a real publication exists on the dest
 * customer DB and a real subscription exists on the source customer DB.
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
const SRC_CUSTOMER_DB = 'cust_e2e_source';
const SRC_CUSTOMER_URI = `postgresql://butterbase:butterbase_dev@localhost:5435/${SRC_CUSTOMER_DB}`;

let env: E2EEnv;
let sagaCtx: any = null;
let driverStop: (() => void) | null = null;
let driverRedis: Redis | null = null;

async function ensureSourceCustomerDb(): Promise<void> {
  const admin = new pg.Pool({ connectionString: SRC_DATA_ADMIN_URI });
  try {
    const r = await admin.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM pg_database WHERE datname = $1`,
      [SRC_CUSTOMER_DB],
    );
    if (r.rows[0].c === 0) await admin.query(`CREATE DATABASE "${SRC_CUSTOMER_DB}"`);
  } finally { await admin.end(); }

  // Drop any leftover subscriptions from previous test runs (each saga creates
  // a uniquely-named one, but they accumulate across runs on the same DB).
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
  const intervals = [
    'ragWorkerInterval', 'flushInterval', 'failureNotifierInterval',
    'neonWorkerInterval', 'analyticsPullerInterval', 'nightlyInterval',
  ];
  const timeouts = ['nightlyTimeout'];
  for (const key of intervals) if (appAny[key]) { clearInterval(appAny[key]); appAny[key] = undefined; }
  for (const key of timeouts) if (appAny[key]) { clearTimeout(appAny[key]); appAny[key] = undefined; }
  sseDispatcher.stop();

  await cleanupAll(env.controlPool);
  await env.shutdown();
}, 60_000);

describe('Phase 6 — move-app happy path us-east-1 → eu-west-1 (real replication)', () => {
  it('saga reaches completed; real publication on dest, real subscription on source', async () => {
    const seeded = await seedApp(env.controlPool, { region: 'us-east-1' });

    // Seed source-side app_db_connections so dumping_data has a real DB to pg_dump.
    const srcRuntime = runtimePoolFor('us-east-1');
    await srcRuntime.query(
      `INSERT INTO app_db_connections (app_id, connection_string, neon_database_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (app_id) DO UPDATE SET connection_string = EXCLUDED.connection_string`,
      [seeded.appId, SRC_CUSTOMER_URI, SRC_CUSTOMER_DB],
    );

    const destRuntime = runtimePoolFor('eu-west-1');

    const { migrationId, driverStop: stop } = await runForwardMoveAppToCompleted({
      env, seeded, destRegion: 'eu-west-1', sagaCtx, driverRedis: driverRedis!,
    });
    driverStop = stop;

    const final = await env.controlPool.query<{ current_step: string; source_replica_state: string }>(
      `SELECT current_step, source_replica_state FROM app_migrations WHERE id = $1`, [migrationId],
    );
    expect(final.rows[0].current_step).toBe('completed');
    expect(final.rows[0].source_replica_state).toBe('replicating');

    // Verify dest apps row
    const destApp = await destRuntime.query<{ region: string; provisioning_status: string }>(
      `SELECT region, provisioning_status FROM apps WHERE id = $1`, [seeded.appId],
    );
    expect(destApp.rows[0]).toMatchObject({ region: 'eu-west-1', provisioning_status: 'ready' });

    // Verify user_app_index flipped on control plane
    const ix = await env.controlPool.query<{ region: string }>(
      `SELECT region FROM user_app_index WHERE app_id = $1`, [seeded.appId],
    );
    expect(ix.rows[0].region).toBe('eu-west-1');

    // Verify KV flipped via mockKv
    const kvVal = await mockKv.get(`sub:${seeded.subdomain}`);
    expect(kvVal).not.toBeNull();
    expect(JSON.parse(kvVal!).region).toBe('eu-west-1');

    // ====================================================================
    // REAL replication assertions: pub on dest customer DB, sub on source.
    // ====================================================================
    const srcConn = await srcRuntime.query<{ connection_string: string }>(
      `SELECT connection_string FROM app_db_connections WHERE app_id = $1`, [seeded.appId],
    );
    const sourceCustomerUri = srcConn.rows[0].connection_string;
    const srcPool = new pg.Pool({ connectionString: sourceCustomerUri, max: 2 });
    try {
      const r = await srcPool.query<{ subname: string }>(
        `SELECT subname FROM pg_subscription
           WHERE subname LIKE 'move_app_sub_%'
             AND subdbid = (SELECT oid FROM pg_database WHERE datname = current_database())`,
      );
      expect(r.rowCount).toBeGreaterThanOrEqual(1);
    } finally { await srcPool.end(); }

    const destConn = await destRuntime.query<{ connection_string: string }>(
      `SELECT connection_string FROM app_db_connections WHERE app_id = $1`, [seeded.appId],
    );
    const destCustomerUri = destConn.rows[0].connection_string;
    const destPool = new pg.Pool({ connectionString: destCustomerUri, max: 2 });
    try {
      const r = await destPool.query<{ pubname: string }>(
        `SELECT pubname FROM pg_publication WHERE pubname LIKE 'move_app_pub_%'`,
      );
      expect(r.rowCount).toBeGreaterThanOrEqual(1);
    } finally { await destPool.end(); }
  }, 180_000);
});
