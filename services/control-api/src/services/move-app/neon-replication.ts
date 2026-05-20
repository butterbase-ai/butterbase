import pg from 'pg';
import { runtimePoolFor } from '../runtime-pool-registry.js';

const PUB_PREFIX = 'move_app_pub_';
const SUB_PREFIX = 'move_app_sub_';

function nameFor(prefix: string, migrationId: string): string {
  // Postgres identifier max 63 bytes. Strip dashes from UUID for compactness.
  return (prefix + migrationId.replace(/-/g, '')).slice(0, 63);
}

/**
 * Resolve the customer DB connection_string for an app in a given region.
 * Read from the app_db_connections row on that region's runtime DB.
 */
async function getCustomerConnectionString(region: string, appId: string): Promise<string> {
  const pool = runtimePoolFor(region);
  const r = await pool.query<{ connection_string: string }>(
    `SELECT connection_string FROM app_db_connections WHERE app_id = $1`, [appId],
  );
  if (r.rows.length === 0) throw new Error(`no app_db_connections for app ${appId} in ${region}`);
  return r.rows[0].connection_string;
}

export interface ConfigureArgs {
  sourceRegion: string;
  destRegion: string;
  appId: string;
  migrationId: string;
}

export interface ConfigureResult {
  slotName: string;
  publicationName: string;
}

/**
 * Configure logical replication from dest (new primary) → source (becoming
 * hot replica). Idempotent — safe to retry.
 */
export async function configureNeonReplication(args: ConfigureArgs): Promise<ConfigureResult> {
  const pub = nameFor(PUB_PREFIX, args.migrationId);
  const sub = nameFor(SUB_PREFIX, args.migrationId);

  const destUri = await getCustomerConnectionString(args.destRegion, args.appId);
  const sourceUri = await getCustomerConnectionString(args.sourceRegion, args.appId);

  // 1. Open pool against DEST customer DB; CREATE PUBLICATION (idempotent).
  const destPool = new pg.Pool({ connectionString: destUri, max: 2 });
  try {
    const exists = await destPool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM pg_publication WHERE pubname = $1`, [pub],
    );
    if (exists.rows[0].c === 0) {
      await destPool.query(`CREATE PUBLICATION "${pub}" FOR ALL TABLES`);
    }
  } finally {
    await destPool.end();
  }

  // 2. Open pool against SOURCE customer DB; CREATE SUBSCRIPTION (idempotent).
  const sourcePool = new pg.Pool({ connectionString: sourceUri, max: 2 });
  try {
    const exists = await sourcePool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM pg_subscription WHERE subname = $1`, [sub],
    );
    if (exists.rows[0].c === 0) {
      // Subscription connection clause cannot be parameterized (it's a connstring literal).
      // The dest URI is built from app_db_connections — trust it. Escape single quotes as a defense.
      const escapedDest = destUri.replace(/'/g, "''");
      await sourcePool.query(
        `CREATE SUBSCRIPTION "${sub}" CONNECTION '${escapedDest}' PUBLICATION "${pub}"`,
      );
    }
  } finally {
    await sourcePool.end();
  }

  return { slotName: sub, publicationName: pub };
}

const DEFAULT_LAG_TIMEOUT_MS = 60_000;
const LAG_POLL_INTERVAL_MS = 500;

export interface WaitArgs {
  sourceRegion: string;
  appId: string;
  migrationId: string;
  timeoutMs?: number;
}

/**
 * Block until the source's subscription has applied every change from dest,
 * or throw if not caught up within timeoutMs.
 *
 * Implementation: poll pg_stat_subscription on the source customer DB.
 * `latest_end_lsn` = LSN we've reported the publisher's WAL position.
 * `received_lsn` = LSN we've received (and applied/queued) so far.
 * pg_wal_lsn_diff(latest_end_lsn, received_lsn) = bytes still to apply.
 * Caught up when diff ≤ 0 (or both columns are NULL, meaning no traffic).
 */
export async function waitForReplicationCaughtUp(args: WaitArgs): Promise<void> {
  const sub = nameFor(SUB_PREFIX, args.migrationId);
  const timeoutMs = args.timeoutMs ?? DEFAULT_LAG_TIMEOUT_MS;
  const sourceUri = await getCustomerConnectionString(args.sourceRegion, args.appId);

  const pool = new pg.Pool({ connectionString: sourceUri, max: 2 });
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const r = await pool.query<{
        exists: boolean;
        lag_bytes: number | null;
        last_msg_receipt_time: Date | null;
      }>(
        `SELECT
           (subname IS NOT NULL) AS exists,
           pg_wal_lsn_diff(latest_end_lsn, received_lsn) AS lag_bytes,
           last_msg_receipt_time
         FROM pg_stat_subscription WHERE subname = $1`,
        [sub],
      );
      if (r.rows.length === 0 || !r.rows[0].exists) {
        throw new Error(`subscription ${sub} not found on source — replication never started or already dropped`);
      }
      const lag = r.rows[0].lag_bytes;
      if (lag === null || lag <= 0) return; // caught up (or idle)
      await new Promise((res) => setTimeout(res, LAG_POLL_INTERVAL_MS));
    }
    throw new Error(`waitForReplicationCaughtUp timed out after ${timeoutMs}ms for subscription ${sub}`);
  } finally {
    await pool.end();
  }
}

export interface PromoteArgs {
  sourceRegion: string;
  appId: string;
  migrationId: string;
}

/**
 * Promote source from hot replica back to independent primary.
 * Drops the subscription so source stops following dest. Source is
 * immediately writable after this returns.
 *
 * Resilient to dest being unreachable: DISABLE + slot detach happen
 * locally on source first; the SUBSCRIPTION DROP needs no publisher contact.
 */
export async function promoteSourceToPrimary(args: PromoteArgs): Promise<void> {
  const sub = nameFor(SUB_PREFIX, args.migrationId);
  const sourceUri = await getCustomerConnectionString(args.sourceRegion, args.appId);
  const pool = new pg.Pool({ connectionString: sourceUri, max: 2 });
  try {
    // 1. Disable so apply worker stops; safe if already disabled.
    await pool.query(`ALTER SUBSCRIPTION "${sub}" DISABLE`).catch((e: any) => {
      // Subscription may not exist (already dropped) — that's fine for idempotent promote.
      if (!String(e.message).includes('does not exist')) throw e;
      return;
    });
    // 2. Detach slot binding so DROP doesn't try to drop the upstream slot.
    await pool.query(`ALTER SUBSCRIPTION "${sub}" SET (slot_name = NONE)`).catch(() => {});
    // 3. Drop the subscription. Since slot_name is NONE, no publisher contact needed.
    await pool.query(`DROP SUBSCRIPTION IF EXISTS "${sub}"`);
  } finally {
    await pool.end();
  }
}

export interface DropArgs {
  sourceRegion: string;
  destRegion: string;
  appId: string;
  migrationId: string;
}

/**
 * Tear down all replication objects for a completed migration.
 * Safe to call after promoteSourceToPrimary (subscription may already be gone).
 * Used by source-replica teardown before deleting the source customer DB.
 */
export async function dropReplicationObjects(args: DropArgs): Promise<void> {
  const sub = nameFor(SUB_PREFIX, args.migrationId);
  const pub = nameFor(PUB_PREFIX, args.migrationId);

  // Source side: drop subscription if still present
  try {
    const sourceUri = await getCustomerConnectionString(args.sourceRegion, args.appId);
    const sourcePool = new pg.Pool({ connectionString: sourceUri, max: 2 });
    try {
      await sourcePool.query(`ALTER SUBSCRIPTION "${sub}" DISABLE`).catch(() => {});
      await sourcePool.query(`ALTER SUBSCRIPTION "${sub}" SET (slot_name = NONE)`).catch(() => {});
      await sourcePool.query(`DROP SUBSCRIPTION IF EXISTS "${sub}"`);
    } finally { await sourcePool.end(); }
  } catch (e: any) {
    // Source DB may already be deleted — fine.
    if (!String(e.message).match(/does not exist|no app_db_connections/i)) throw e;
  }

  // Dest side: drop publication if still present
  try {
    const destUri = await getCustomerConnectionString(args.destRegion, args.appId);
    const destPool = new pg.Pool({ connectionString: destUri, max: 2 });
    try {
      await destPool.query(`DROP PUBLICATION IF EXISTS "${pub}"`);
    } finally { await destPool.end(); }
  } catch (e: any) {
    if (!String(e.message).match(/does not exist|no app_db_connections/i)) throw e;
  }
}

/**
 * Robust catch-up check: write a sentinel row on dest with the current
 * timestamp, then poll source for that exact row. Returns when seen.
 * More expensive (creates a tiny table) but immune to LSN race conditions.
 *
 * Only used by reverse-move where extra robustness is worth it.
 */
export async function waitForReplicationCaughtUpViaSentinel(args: WaitArgs & { destRegion: string }): Promise<void> {
  const timeoutMs = args.timeoutMs ?? DEFAULT_LAG_TIMEOUT_MS;
  const sourceUri = await getCustomerConnectionString(args.sourceRegion, args.appId);
  const destUri = await getCustomerConnectionString(args.destRegion, args.appId);
  const sentinelTable = `_move_app_sentinel`;
  const sentinelId = `m-${args.migrationId.slice(0, 8)}-${Date.now()}`;

  const destPool = new pg.Pool({ connectionString: destUri, max: 2 });
  const sourcePool = new pg.Pool({ connectionString: sourceUri, max: 2 });
  try {
    // Ensure the sentinel table exists on dest (publication FOR ALL TABLES will pick it up,
    // but if subscription was created BEFORE the table existed, we need REFRESH).
    await destPool.query(`CREATE TABLE IF NOT EXISTS ${sentinelTable} (id TEXT PRIMARY KEY, t TIMESTAMPTZ DEFAULT now())`);
    // Same on source so the subscription has a target. Idempotent.
    await sourcePool.query(`CREATE TABLE IF NOT EXISTS ${sentinelTable} (id TEXT PRIMARY KEY, t TIMESTAMPTZ DEFAULT now())`);
    // Refresh subscription to pick up the new table if it was added after CREATE SUBSCRIPTION.
    const sub = nameFor(SUB_PREFIX, args.migrationId);
    await sourcePool.query(`ALTER SUBSCRIPTION "${sub}" REFRESH PUBLICATION`).catch(() => {});

    await destPool.query(`INSERT INTO ${sentinelTable} (id) VALUES ($1)`, [sentinelId]);

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const r = await sourcePool.query(`SELECT id FROM ${sentinelTable} WHERE id = $1`, [sentinelId]);
      if (r.rowCount && r.rowCount > 0) return;
      await new Promise((res) => setTimeout(res, LAG_POLL_INTERVAL_MS));
    }
    throw new Error(`sentinel ${sentinelId} not seen on source within ${timeoutMs}ms`);
  } finally {
    await destPool.end();
    await sourcePool.end();
  }
}
