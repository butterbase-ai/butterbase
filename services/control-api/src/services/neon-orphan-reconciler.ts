import type pg from 'pg';
import { config } from '../config.js';
import { getDataProjectIdForRegion } from './neon-projects.js';
import { getRuntimeDbPool, type RuntimeDbConfig } from './runtime-db.js';
import * as neonClient from './neon-client.js';

interface Logger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

/**
 * Neon data-plane databases whose corresponding `apps.db_name` row no longer
 * exists in the runtime DB are orphans. They pile up when `provisionAppBackground`
 * crashes after `createDatabase` but before `INSERT INTO app_db_connections`
 * (a ~200ms window that widens on Neon API 5xx, Fly instance rolls during
 * provisioning, or a developer-mode bug that throws mid-provision — see the
 * 2026-07-07 spike caused by a provisioner fix cycle for a real-world case).
 *
 * The delete path is fine on its own (`executeDeprovision` correctly calls
 * `deleteDatabase` when `app_db_connections` has a row). This reconciler
 * catches the orphans that fall through THAT precondition.
 *
 * Safeties:
 *   - grace hours: never touch a DB younger than `graceHours` (default 24) —
 *     protects mid-provision apps from being nuked before their app row is written.
 *   - in-flight task guard: never touch a DB whose app_id has a pending or
 *     processing `neon_tasks` row — the task worker owns that DB right now.
 *   - max-drops cap: bounds blast radius per run (default 10). Older orphans
 *     go first.
 *   - dry-run default: unless `NEON_ORPHAN_DRY_RUN=false` is explicit, we just
 *     log what we WOULD drop.
 *   - ambiguity bail-out (cust_* only): if we cannot reconstruct the database
 *     name exactly from a known app id, we treat it as NOT an orphan. A missed
 *     orphan costs storage; a wrong drop destroys customer data.
 *
 * Two naming shapes exist:
 *   - `db_app_<id>`            — provisionAppBackground / executeProvision.
 *   - `cust_<appId>_<region>`  — provisionAppDb, the move-app destination DB.
 * See `custDbNameFor` for why the second is matched forwards, never inverted.
 */

export interface ReconcileResult {
  region: string;
  neonDbCount: number;
  liveAppCount: number;
  orphanCount: number;
  eligibleCount: number;
  dropped: string[];
  wouldDrop: string[];
  skippedYoung: number;
  skippedInflight: number;
  /** cust_* databases we refused to classify because the name could not be
   *  reconstructed unambiguously. Always treated as NOT orphans. */
  skippedAmbiguous: number;
  dropErrors: { db: string; error: string }[];
}

export interface ReconcileOptions {
  graceHours: number;
  maxDropsPerRun: number;
  dryRun: boolean;
  /** ISO string; overridable for tests. */
  now?: string;
}

/** Named prefix for per-app data-plane databases — matches provisioner.ts:145. */
const APP_DB_PREFIX = 'db_app_';

/** Prefix for move-app destination databases — matches `provisionAppDb`. */
const CUST_DB_PREFIX = 'cust_';

/** Postgres `datname` limit. `provisionAppDb` truncates to this. */
const PG_MAX_DATNAME = 63;

/**
 * Reproduce `provisionAppDb`'s destination-database name EXACTLY.
 *
 * We match forwards (compute the expected name for every known app id and
 * compare) rather than inverting the name back to an app id, because the
 * transform is not injective:
 *   - `-` → `_` collapses two distinct characters into one,
 *   - `.toLowerCase()` collapses case,
 *   - `.slice(0, 63)` is outright lossy.
 * Inverting would mean guessing, and a wrong guess here drops a live customer
 * database. Forward-matching cannot produce a false positive.
 */
export function custDbNameFor(appId: string, region: string): string {
  return `cust_${appId.replace(/-/g, '_')}_${region.replace(/-/g, '_')}`
    .toLowerCase()
    .slice(0, PG_MAX_DATNAME);
}

/** Same normalisation applied to the app-id segment alone — used to line a
 *  cust_* name up with `neon_tasks.app_id` for the in-flight guard. */
function appIdSlug(appId: string): string {
  return appId.replace(/-/g, '_').toLowerCase();
}

export async function reconcileOrphansForRegion(
  region: string,
  controlDb: pg.Pool,
  runtimeDbCfg: RuntimeDbConfig,
  logger: Logger,
  opts: ReconcileOptions,
): Promise<ReconcileResult> {
  const projectId = getDataProjectIdForRegion(region);
  const runtimePool = getRuntimeDbPool(runtimeDbCfg, region);

  const nowMs = opts.now ? new Date(opts.now).getTime() : Date.now();
  const graceMs = opts.graceHours * 3600 * 1000;

  // 1. Full Neon inventory for this project's default branch. Both naming
  //    shapes are in scope; anything else (neondb, internal dbs) is ignored.
  const neonDbs = (await neonClient.listDatabases(projectId))
    .filter((db) => db.name.startsWith(APP_DB_PREFIX) || db.name.startsWith(CUST_DB_PREFIX));

  // 2. Every app row currently registered for this region.
  const liveRes = await runtimePool.query<{ db_name: string }>(
    `SELECT db_name FROM apps WHERE region = $1`,
    [region],
  );
  const liveDbNames = new Set(liveRes.rows.map((r) => r.db_name));

  // 2b. cust_* liveness. Deliberately NOT region-filtered: a move-app
  //     destination database is created in the target region before the app's
  //     `apps.region` flips over, so filtering by region here would make a
  //     mid-move database look like an orphan.
  const custAppsRes = await runtimePool.query<{ id: string }>(`SELECT id FROM apps`);
  const liveCustNames = new Set(
    custAppsRes.rows.map((r) => r.id).filter(Boolean).map((id) => custDbNameFor(id, region)),
  );

  // 2c. Anything already registered in app_db_connections is owned by an app,
  //     even if the corresponding `apps` row lives in the source region's
  //     runtime DB. `provisionAppDb` writes this row as its first durable act.
  const registeredRes = await runtimePool.query<{ neon_database_name: string | null }>(
    `SELECT neon_database_name FROM app_db_connections`,
  );
  const registeredDbNames = new Set(
    registeredRes.rows.map((r) => r.neon_database_name).filter((n): n is string => Boolean(n)),
  );

  // 3. In-flight provision/deprovision tasks — do NOT touch their app_ids.
  //    A pending 'provision' task means the DB may exist but the app row
  //    hasn't been written yet (opposite side of the same race we're cleaning
  //    up); a pending 'deprovision' means the task worker will drop it soon.
  const inflightRes = await runtimePool.query<{ app_id: string }>(
    `SELECT DISTINCT app_id FROM neon_tasks
      WHERE task_type IN ('provision', 'deprovision')
        AND status IN ('pending', 'processing')`,
  );
  const inflightAppIds = new Set(inflightRes.rows.map((r) => r.app_id));
  const inflightAppIdSlugs = new Set([...inflightAppIds].map(appIdSlug));

  // 4. Diff.
  //    db_app_<id> ↔ apps.db_name is 'app_<id>' — strip the 'db_' prefix.
  //    cust_<appId>_<region> is matched forwards against custDbNameFor().
  const custSuffix = `_${region.replace(/-/g, '_').toLowerCase()}`;
  const orphans: { name: string; appId: string; createdAt: string; ageMs: number }[] = [];
  let skippedYoung = 0;
  let skippedInflight = 0;
  let skippedAmbiguous = 0;
  let unmatchedNeonCount = 0; // Neon dbs with no live app row (before grace/inflight filters)
  for (const db of neonDbs) {
    let appId: string;

    if (db.name.startsWith(APP_DB_PREFIX)) {
      appId = db.name.slice('db_'.length); // 'db_app_XXX' → 'app_XXX'
      if (liveDbNames.has(appId)) continue;
    } else {
      // cust_* — a move-app destination database.
      if (registeredDbNames.has(db.name) || liveCustNames.has(db.name)) continue;

      // Everything below is a reason we cannot *prove* the database is
      // unowned, so we decline to classify it rather than risk a bad drop.
      //
      //  - length >= 63: the name may have been truncated, so the app-id
      //    segment (and possibly the region suffix) is incomplete.
      //  - missing region suffix: not the shape provisionAppDb produces for
      //    this region, so we do not understand who created it.
      //  - empty app-id segment: nothing to guard the in-flight check with.
      if (db.name.length >= PG_MAX_DATNAME || !db.name.endsWith(custSuffix)) {
        skippedAmbiguous++;
        continue;
      }
      const slug = db.name.slice(CUST_DB_PREFIX.length, db.name.length - custSuffix.length);
      if (!slug) {
        skippedAmbiguous++;
        continue;
      }
      // The slug is only used for the in-flight guard and for logging — never
      // to decide liveness, which was settled by the forward match above.
      appId = slug;
      if (inflightAppIdSlugs.has(slug)) {
        unmatchedNeonCount++;
        skippedInflight++;
        continue;
      }
    }

    unmatchedNeonCount++;
    if (inflightAppIds.has(appId)) {
      skippedInflight++;
      continue;
    }
    const ageMs = nowMs - new Date(db.createdAt).getTime();
    if (ageMs < graceMs) {
      skippedYoung++;
      continue;
    }
    orphans.push({ name: db.name, appId, createdAt: db.createdAt, ageMs });
  }
  // Live apps whose db_name doesn't exist in Neon — the inverse orphan class
  // (broken app that will 3D000 on query). We only log the count; fixing them
  // is out of scope for this reconciler. Scoped to the db_app_ shape only.
  const missingNeonForLive = liveDbNames.size
    - neonDbs.filter((db) =>
        db.name.startsWith(APP_DB_PREFIX) && liveDbNames.has(db.name.slice('db_'.length)),
      ).length;

  // Oldest first — pick from the most-clearly-orphaned end when the cap bites.
  orphans.sort((a, b) => a.ageMs - b.ageMs > 0 ? -1 : 1);
  const eligibleCount = orphans.length;
  const toProcess = orphans.slice(0, opts.maxDropsPerRun);

  const result: ReconcileResult = {
    region,
    neonDbCount: neonDbs.length,
    liveAppCount: liveDbNames.size,
    orphanCount: unmatchedNeonCount,
    eligibleCount,
    dropped: [],
    wouldDrop: [],
    skippedYoung,
    skippedInflight,
    skippedAmbiguous,
    dropErrors: [],
  };

  logger.info(
    {
      region,
      neonDbCount: result.neonDbCount,
      liveAppCount: result.liveAppCount,
      orphanCount: result.orphanCount,
      // Inverse case — live app rows pointing at non-existent Neon dbs. Not
      // acted on here (deleting an app row would be wrong; those apps are
      // just broken), but surfaced so an operator can grep for it.
      missingNeonForLive,
      eligibleCount,
      skippedYoung,
      skippedInflight,
      skippedAmbiguous,
      cappedAt: opts.maxDropsPerRun,
      willProcess: toProcess.length,
      mode: opts.dryRun ? 'dry-run' : 'drop',
    },
    '[orphan-reconciler] scan complete',
  );

  for (const o of toProcess) {
    if (opts.dryRun) {
      result.wouldDrop.push(o.name);
      logger.info(
        { region, db: o.name, appId: o.appId, ageHours: (o.ageMs / 3600 / 1000).toFixed(1), createdAt: o.createdAt },
        '[orphan-reconciler] WOULD DROP (dry-run)',
      );
      continue;
    }
    try {
      // Serialize against concurrent provisioner mutations on the same project.
      await neonClient.withNeonProjectLock(projectId, () =>
        neonClient.deleteDatabase(projectId, o.name),
      );
      result.dropped.push(o.name);
      logger.info(
        { region, db: o.name, appId: o.appId, ageHours: (o.ageMs / 3600 / 1000).toFixed(1), createdAt: o.createdAt },
        '[orphan-reconciler] DROPPED',
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.dropErrors.push({ db: o.name, error: msg });
      logger.warn(
        { region, db: o.name, appId: o.appId, error: msg },
        '[orphan-reconciler] drop failed — will retry next run',
      );
    }
  }

  return result;
}

/**
 * Iterate every configured region and reconcile. Returns per-region results
 * so the caller (usually the scheduled runner) can log a summary and expose
 * metrics.
 */
export async function reconcileOrphans(
  controlDb: pg.Pool,
  runtimeDbCfg: RuntimeDbConfig,
  logger: Logger,
  opts: ReconcileOptions,
): Promise<ReconcileResult[]> {
  const regionsRaw = process.env.BUTTERBASE_REGIONS ?? '';
  const regions = regionsRaw.split(',').map((s) => s.trim()).filter(Boolean);
  if (regions.length === 0) {
    logger.warn({}, '[orphan-reconciler] BUTTERBASE_REGIONS empty — nothing to reconcile');
    return [];
  }
  const results: ReconcileResult[] = [];
  for (const region of regions) {
    try {
      results.push(await reconcileOrphansForRegion(region, controlDb, runtimeDbCfg, logger, opts));
    } catch (err) {
      logger.error({ err, region }, '[orphan-reconciler] region failed — skipping');
    }
  }
  const totals = results.reduce(
    (a, r) => ({
      dropped: a.dropped + r.dropped.length,
      wouldDrop: a.wouldDrop + r.wouldDrop.length,
      skippedYoung: a.skippedYoung + r.skippedYoung,
      skippedInflight: a.skippedInflight + r.skippedInflight,
      skippedAmbiguous: a.skippedAmbiguous + r.skippedAmbiguous,
      errors: a.errors + r.dropErrors.length,
    }),
    { dropped: 0, wouldDrop: 0, skippedYoung: 0, skippedInflight: 0, skippedAmbiguous: 0, errors: 0 },
  );
  logger.info(
    { ...totals, regionsScanned: results.length, mode: opts.dryRun ? 'dry-run' : 'drop' },
    '[orphan-reconciler] cycle complete',
  );
  return results;
}
