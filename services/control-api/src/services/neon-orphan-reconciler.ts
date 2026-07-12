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

  // 1. Full Neon inventory for this project's default branch.
  const neonDbs = (await neonClient.listDatabases(projectId))
    .filter((db) => db.name.startsWith(APP_DB_PREFIX));

  // 2. Every app row currently registered for this region.
  const liveRes = await runtimePool.query<{ db_name: string }>(
    `SELECT db_name FROM apps WHERE region = $1`,
    [region],
  );
  const liveDbNames = new Set(liveRes.rows.map((r) => r.db_name));

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

  // 4. Diff. Neon db_app_<id> ↔ apps.db_name is 'app_<id>' — strip the 'db_' prefix.
  const orphans: { name: string; appId: string; createdAt: string; ageMs: number }[] = [];
  let skippedYoung = 0;
  let skippedInflight = 0;
  for (const db of neonDbs) {
    const appId = db.name.slice('db_'.length); // 'db_app_XXX' → 'app_XXX'
    if (liveDbNames.has(appId)) continue;
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

  // Oldest first — pick from the most-clearly-orphaned end when the cap bites.
  orphans.sort((a, b) => a.ageMs - b.ageMs > 0 ? -1 : 1);
  const eligibleCount = orphans.length;
  const toProcess = orphans.slice(0, opts.maxDropsPerRun);

  const result: ReconcileResult = {
    region,
    neonDbCount: neonDbs.length,
    liveAppCount: liveDbNames.size,
    orphanCount: neonDbs.length - liveDbNames.size,
    eligibleCount,
    dropped: [],
    wouldDrop: [],
    skippedYoung,
    skippedInflight,
    dropErrors: [],
  };

  logger.info(
    {
      region,
      neonDbCount: result.neonDbCount,
      liveAppCount: result.liveAppCount,
      orphanCount: result.orphanCount,
      eligibleCount,
      skippedYoung,
      skippedInflight,
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
      errors: a.errors + r.dropErrors.length,
    }),
    { dropped: 0, wouldDrop: 0, skippedYoung: 0, skippedInflight: 0, errors: 0 },
  );
  logger.info(
    { ...totals, regionsScanned: results.length, mode: opts.dryRun ? 'dry-run' : 'drop' },
    '[orphan-reconciler] cycle complete',
  );
  return results;
}
