/**
 * Phase 6 Task 10 — shared move-app E2E flow.
 *
 * Two helpers:
 *   - buildE2ESagaCtx: build a sagaCtx for the local cron-scheduler driver
 *     that wraps the production injectors with E2E-specific shims:
 *       * provisionAppDb wrapper that also seeds dest app_db_connections
 *       * readSource/DestConnectionUri that read app_db_connections rows
 *       * configureNeonReplication that runs the REAL pub/sub SQL but
 *         rewrites the embedded dest URI from `localhost:<host-port>` to the
 *         compose-network service name so the SOURCE container can dial DEST
 *       * runPsql override that strips PG17+-only SETs PG16 rejects
 *
 *   - runForwardMoveAppToCompleted: drive the full forward saga end-to-end.
 *     Used by scenarios 9 and 11 to exercise REAL Neon logical replication
 *     (publication on dest customer DB, subscription on source customer DB).
 *
 * Hostname translation: the local docker-compose has both data-plane Postgres
 * containers on the `butterbase` bridge network. The host process reaches
 * them via published ports (localhost:5435/5436). The CREATE SUBSCRIPTION
 * dialed FROM inside the source container needs a hostname the container can
 * resolve — `host.docker.internal` is NOT mapped on macOS hosts by default,
 * so we use the compose service name + internal port.
 */
import pg from 'pg';
import Redis from 'ioredis';
import { spawn } from 'node:child_process';
import { Transform, type Readable } from 'node:stream';
import type { E2EEnv } from './boot.js';
import type { SeededApp } from './seed.js';
import { pollUntil } from './poll.js';
import { runtimePoolFor, redisFor } from '../../../services/control-api/src/services/runtime-pool-registry.js';
import { provisionAppDb } from '../../../services/control-api/src/services/provisioner.js';
import { startMoveAppDriver } from '../../../services/cron-scheduler/src/move-app-driver.js';
import { stepHandlers } from '../../../services/control-api/src/services/move-app/step-registry.js';

/**
 * Map host-published localhost URIs → compose-network service URIs.
 * Used only when embedding a URI inside CREATE SUBSCRIPTION SQL that the
 * source container will execute (and dial) itself.
 */
function rewriteForContainer(uri: string): string {
  const u = new URL(uri);
  if (u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') return uri;
  // Map host-published port → compose service name + internal port (5432).
  const portMap: Record<string, string> = {
    '5435': 'butterbase-data-plane-db-1',     // us-east-1 data plane
    '5436': 'butterbase-data-plane-db-eu-1',  // eu-west-1 data plane
  };
  const service = portMap[u.port];
  if (!service) return uri;
  u.hostname = service;
  u.port = '5432';
  return u.toString();
}

/**
 * Real configureNeonReplication for E2E: same SQL as production
 * services/control-api/src/services/move-app/neon-replication.ts, except the
 * destUri embedded in CREATE SUBSCRIPTION is rewritten so the source
 * container can dial dest via the compose bridge network.
 */
async function configureNeonReplicationE2E(args: {
  sourceRegion: string; destRegion: string; appId: string; migrationId: string;
}): Promise<{ slotName: string; publicationName: string }> {
  const PUB_PREFIX = 'move_app_pub_';
  const SUB_PREFIX = 'move_app_sub_';
  const idCompact = args.migrationId.replace(/-/g, '');
  const pub = (PUB_PREFIX + idCompact).slice(0, 63);
  const sub = (SUB_PREFIX + idCompact).slice(0, 63);

  const readUri = async (region: string): Promise<string> => {
    const pool = runtimePoolFor(region);
    const r = await pool.query<{ connection_string: string }>(
      `SELECT connection_string FROM app_db_connections WHERE app_id = $1`, [args.appId],
    );
    if (r.rows.length === 0) throw new Error(`no app_db_connections for app ${args.appId} in ${region}`);
    return r.rows[0].connection_string;
  };
  const destUri = await readUri(args.destRegion);
  const sourceUri = await readUri(args.sourceRegion);
  const destUriForSubscription = rewriteForContainer(destUri);

  // 1. Open pool against DEST customer DB; CREATE PUBLICATION (idempotent).
  const destPool = new pg.Pool({ connectionString: destUri, max: 2 });
  try {
    const ex = await destPool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM pg_publication WHERE pubname = $1`, [pub],
    );
    if (ex.rows[0].c === 0) {
      await destPool.query(`CREATE PUBLICATION "${pub}" FOR ALL TABLES`);
    }
  } finally { await destPool.end(); }

  // 2. Open pool against SOURCE customer DB; CREATE SUBSCRIPTION with the
  //    container-rewritten destUri.
  const sourcePool = new pg.Pool({ connectionString: sourceUri, max: 2 });
  try {
    const ex = await sourcePool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM pg_subscription WHERE subname = $1`, [sub],
    );
    if (ex.rows[0].c === 0) {
      const escaped = destUriForSubscription.replace(/'/g, "''");
      await sourcePool.query(
        `CREATE SUBSCRIPTION "${sub}" CONNECTION '${escaped}' PUBLICATION "${pub}"`,
      );
    }
  } finally { await sourcePool.end(); }

  return { slotName: sub, publicationName: pub };
}

/**
 * Build a sagaCtx for the cron-scheduler driver that runs the full saga
 * end-to-end against the local two-cluster Postgres setup with REAL Neon
 * logical replication.
 */
export function buildE2ESagaCtx(env: E2EEnv): any {
  const baseCtx: any = (env.app as any).moveAppCtx;
  if (!baseCtx) throw new Error('app.moveAppCtx not decorated');

  return {
    ...baseCtx,
    log: env.app.log,
    redisFor,

    // Wrap provisionAppDb to also seed app_db_connections on the dest runtime.
    provisionAppDb: async (region: string, appId: string, ownerId: string) => {
      const out = await provisionAppDb(region, appId, ownerId);
      const destRuntime = runtimePoolFor(region);
      await destRuntime.query(
        `INSERT INTO app_db_connections (app_id, connection_string, neon_database_name)
         VALUES ($1, $2, $3)
         ON CONFLICT (app_id) DO UPDATE
           SET connection_string = EXCLUDED.connection_string,
               neon_database_name = EXCLUDED.neon_database_name`,
        [appId, out.connectionUri, out.neonDbName],
      );
      return out;
    },
    readSourceConnectionUri: async (region: string, appId: string) => {
      const pool = runtimePoolFor(region);
      const r = await pool.query<{ connection_string: string }>(
        `SELECT connection_string FROM app_db_connections WHERE app_id = $1`, [appId],
      );
      if (r.rows.length === 0) throw new Error(`no source app_db_connections for ${appId}`);
      return r.rows[0].connection_string;
    },
    readDestConnectionUri: async (region: string, appId: string) => {
      const pool = runtimePoolFor(region);
      const r = await pool.query<{ connection_string: string }>(
        `SELECT connection_string FROM app_db_connections WHERE app_id = $1`, [appId],
      );
      if (r.rows.length === 0) throw new Error(`no dest app_db_connections for ${appId}`);
      return r.rows[0].connection_string;
    },

    // REAL replication setup with hostname translation for cross-container dial.
    configureNeonReplication: configureNeonReplicationE2E,

    // PG18 client → PG16 server: strip transaction_timeout SET that PG16 rejects.
    runPsql: async (connUri: string, sqlStream: NodeJS.ReadableStream) => {
      const filter = new Transform({
        transform(chunk, _enc, cb) {
          const out = chunk.toString('utf8')
            .replace(/^SET transaction_timeout\s*=.*$/gm, '-- stripped: transaction_timeout');
          cb(null, Buffer.from(out, 'utf8'));
        },
      });
      return await new Promise<{ rowsApplied: number }>((resolve, reject) => {
        const psql = spawn('psql', ['--single-transaction', '--no-psqlrc', '-v', 'ON_ERROR_STOP=1', connUri], {
          stdio: ['pipe', 'pipe', 'pipe'], env: process.env,
        });
        const errs: string[] = [];
        psql.stderr.on('data', (b) => errs.push(b.toString()));
        psql.on('exit', (code) => {
          if (code === 0) resolve({ rowsApplied: 0 });
          else reject(new Error(`psql exit ${code}: ${errs.join('').slice(0, 1024)}`));
        });
        (sqlStream as Readable).pipe(filter).pipe(psql.stdin!);
      });
    },
  };
}

/**
 * Drive the forward move-app saga to `completed`. Returns the migration id.
 * Caller must ensure the source customer DB exists and that source-side
 * app_db_connections is seeded.
 */
export async function runForwardMoveAppToCompleted(opts: {
  env: E2EEnv;
  seeded: SeededApp;
  destRegion: string;
  sagaCtx: any;
  driverRedis: Redis;
}): Promise<{ migrationId: string; driverStop: () => void }> {
  const init = await opts.env.app.inject({
    method: 'POST',
    url: `/v1/apps/${opts.seeded.appId}/move`,
    payload: { dest_region: opts.destRegion },
    headers: { 'x-test-user-id': opts.seeded.userId, 'content-type': 'application/json' },
  });
  if (init.statusCode !== 202) {
    throw new Error(`POST /move expected 202 got ${init.statusCode}: ${init.body}`);
  }
  const migrationId = init.json().migration_id;

  const handle = startMoveAppDriver({
    ctx: opts.sagaCtx, redis: opts.driverRedis, handlers: stepHandlers, intervalMs: 500,
  });

  const final = await pollUntil(async () => {
    const r = await opts.env.controlPool.query<{
      current_step: string; last_error: string | null; source_replica_state: string | null;
    }>(
      `SELECT current_step, last_error, source_replica_state FROM app_migrations WHERE id = $1`,
      [migrationId],
    );
    const row = r.rows[0];
    if (!row) return null;
    if (row.current_step === 'failed') throw new Error(`saga failed: ${row.last_error}`);
    if (row.current_step === 'completed') return row;
    return null;
  }, 150_000, 1_000);

  if (final.current_step !== 'completed') {
    throw new Error(`saga did not complete: ${JSON.stringify(final)}`);
  }
  return { migrationId, driverStop: handle.stop };
}
