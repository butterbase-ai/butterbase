import pg from 'pg';
import { captureAppState, type AppStateManifest } from './app-state-capture.js';
import { config } from '../config.js';
import { getRuntimeDbPool } from './runtime-db.js';

export interface LineageRow {
  dest_app_id: string;
  dest_region: string;
  source_app_id: string;
  source_region: string;
  base_release_id: string | null;
  base_fingerprint: AppStateManifest | null;
  base_snapshot_id: string | null;
  severed_at: Date | null;
  cloned_at: Date;
}

export interface DriftResult {
  is_fork: boolean;
  severed: boolean;
  source_app_id: string | null;
  behind_by: number;
  releases: { release_number: number; label: string | null; notes: string | null; published_at: Date }[];
}

export interface Divergence {
  repo: boolean | null;       // null = unknown (no base snapshot recorded)
  frontend: boolean;
  schema: boolean | null;     // null = unknown (no backend base)
  rls: boolean | null;
  functions: boolean | null;
  config: boolean | null;
  has_backend_base: boolean;
}

export interface ForkBuckets {
  total: number;
  current: number;
  behind_unmodified: number;
  behind_modified: number;
  /**
   * Behind forks whose repo state could not be determined — either the fork
   * has no trustworthy base_snapshot_id at all, or its region's runtime DB
   * was unreachable (see `degraded_regions`). Never guessed into modified or
   * unmodified: these counts drive a build/don't-build decision on a merge
   * engine, and folding "we don't know" into "modified" would bias that
   * decision without evidence.
   */
  unknown: number;
  /**
   * Regions whose runtime DB could not be reached while computing repo state
   * for this call. Every behind fork in a degraded region is counted in
   * `unknown`, not guessed. Callers should surface a non-empty list to the
   * template owner as "counts may be incomplete".
   */
  degraded_regions: string[];
}

export async function recordLineage(
  controlDb: pg.Pool,
  args: {
    destAppId: string; destRegion: string;
    sourceAppId: string; sourceRegion: string;
    baseReleaseId: string | null;
    baseFingerprint: AppStateManifest | null;
    baseSnapshotId: string | null;
  },
): Promise<void> {
  await controlDb.query(
    `INSERT INTO app_lineage
       (dest_app_id, dest_region, source_app_id, source_region,
        base_release_id, base_fingerprint, base_snapshot_id)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
     ON CONFLICT (dest_app_id) DO NOTHING`,
    [args.destAppId, args.destRegion, args.sourceAppId, args.sourceRegion,
     args.baseReleaseId,
     args.baseFingerprint ? JSON.stringify(args.baseFingerprint) : null,
     args.baseSnapshotId],
  );
}

export async function getLineage(controlDb: pg.Pool, destAppId: string): Promise<LineageRow | null> {
  const res = await controlDb.query<LineageRow>(
    `SELECT * FROM app_lineage WHERE dest_app_id = $1`, [destAppId],
  );
  return res.rows[0] ?? null;
}

/**
 * How far behind this fork is. Computed on READ — publishing writes nothing to
 * any fork. Pushing an `update_available` flag into every region's runtime DB is
 * the pattern that produced the fork_count gap; a read-time query cannot go stale
 * because there is no denormalized copy.
 */
export async function computeDrift(controlDb: pg.Pool, destAppId: string): Promise<DriftResult> {
  const lineage = await getLineage(controlDb, destAppId);
  if (!lineage) {
    return { is_fork: false, severed: false, source_app_id: null, behind_by: 0, releases: [] };
  }
  if (lineage.severed_at) {
    return { is_fork: true, severed: true, source_app_id: lineage.source_app_id, behind_by: 0, releases: [] };
  }

  let rows;
  if (lineage.base_release_id) {
    const baseRow = await controlDb.query<{ release_number: number }>(
      `SELECT release_number FROM template_releases WHERE id = $1`, [lineage.base_release_id],
    );
    const baseNumber = baseRow.rows[0]?.release_number ?? 0;
    rows = await controlDb.query(
      `SELECT release_number, label, notes, published_at
         FROM template_releases
        WHERE source_app_id = $1 AND release_number > $2
        ORDER BY release_number DESC`,
      [lineage.source_app_id, baseNumber],
    );
  } else {
    // Fork predates releases (or was cloned from live): anything published after
    // it was cloned is news to it.
    rows = await controlDb.query(
      `SELECT release_number, label, notes, published_at
         FROM template_releases
        WHERE source_app_id = $1 AND published_at > $2
        ORDER BY release_number DESC`,
      [lineage.source_app_id, lineage.cloned_at],
    );
  }

  return {
    is_fork: true, severed: false,
    source_app_id: lineage.source_app_id,
    behind_by: rows.rows.length,
    releases: rows.rows as DriftResult['releases'],
  };
}

/**
 * Has this fork changed since it was cloned? Booleans only — never a diff.
 *
 * repo:     one column compare. Exact and free, because executeClone copies the
 *           manifest verbatim and calls setLatest(dest, source_snapshot_id), so a
 *           fresh fork's HEAD *is* the upstream snapshot id it came from.
 * frontend: needs its own signal — a fork can redeploy without touching its repo
 *           (dashboard upload, built elsewhere), which repo divergence would miss.
 *           replayFrontend inserts exactly one deployment row at clone time.
 * backend:  per-surface hash compare. Requires a live introspect, so callers
 *           should invoke this on the detail view, not on every page load.
 */
export async function computeDivergence(
  controlDb: pg.Pool,
  runtimePool: pg.Pool,
  appPool: pg.Pool,
  destAppId: string,
): Promise<Divergence> {
  const lineage = await getLineage(controlDb, destAppId);
  if (!lineage) {
    return { repo: null, frontend: false, schema: null, rls: null,
             functions: null, config: null, has_backend_base: false };
  }

  const appRow = await runtimePool.query<{ repo_latest_snapshot: string | null }>(
    `SELECT repo_latest_snapshot FROM apps WHERE id = $1`, [destAppId],
  );
  const repo = lineage.base_snapshot_id === null
    ? null
    : (appRow.rows[0]?.repo_latest_snapshot ?? null) !== lineage.base_snapshot_id;

  const deployRow = await runtimePool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM app_deployments
      WHERE app_id = $1 AND created_at > $2`,
    [destAppId, lineage.cloned_at],
  );
  const frontend = Number(deployRow.rows[0]?.count ?? '0') > 0;

  let baseHashes: AppStateManifest['hashes'] | null = null;
  if (lineage.base_fingerprint) {
    baseHashes = lineage.base_fingerprint.hashes;
  } else if (lineage.base_release_id) {
    const rel = await controlDb.query<{ manifest: AppStateManifest }>(
      `SELECT manifest FROM template_releases WHERE id = $1`, [lineage.base_release_id],
    );
    baseHashes = rel.rows[0]?.manifest?.hashes ?? null;
  }

  if (!baseHashes) {
    return { repo, frontend, schema: null, rls: null, functions: null,
             config: null, has_backend_base: false };
  }

  const now = await captureAppState(runtimePool, appPool, destAppId);
  return {
    repo, frontend,
    schema: now.hashes.schema !== baseHashes.schema,
    rls: now.hashes.rls !== baseHashes.rls,
    functions: now.hashes.functions !== baseHashes.functions,
    config: now.hashes.config !== baseHashes.config,
    has_backend_base: true,
  };
}

/** "This is my own app now." Lineage is retained for attribution. */
export async function severLineage(controlDb: pg.Pool, destAppId: string): Promise<boolean> {
  const res = await controlDb.query(
    `UPDATE app_lineage SET severed_at = now()
      WHERE dest_app_id = $1 AND severed_at IS NULL`,
    [destAppId],
  );
  return (res.rowCount ?? 0) > 0;
}

type ForkLineageForBucketing = {
  dest_app_id: string;
  dest_region: string;
  base_release_id: string | null;
  base_snapshot_id: string | null;
  cloned_at: Date;
  base_release_number: number | null;
};

/**
 * Template-owner view. Four count buckets — this is the instrument that tells
 * us whether a merge engine has an audience before we build one, so a "we
 * cannot tell" fork is reported as its own number rather than guessed into
 * modified or unmodified: silently assuming the worst here would bias that
 * build/don't-build decision without evidence, the same distortion a broken
 * proxy caused before (see below).
 *
 * `current` is decided purely from control-plane data — a fork that is NOT
 * behind lands in `current` regardless of repo state, because drift doesn't
 * require the runtime lookup at all. Only forks that ARE behind get
 * subdivided into unmodified / modified / unknown; a current-but-unreachable
 * fork is still `current`, never `unknown`.
 *
 * "Behind" is the same two-tier rule as computeDrift, evaluated per fork against
 * one shared release list for the template (bounded by release count, not fork
 * count): a fork with a base_release_id is behind when a release exists with a
 * HIGHER release_number than its base; a fork without one (including a live
 * clone, whose base lives in base_fingerprint rather than a release row) is
 * behind when a release was published after its cloned_at.
 *
 * "Modified" (for a behind fork) is the real repo signal — apps.repo_latest_snapshot
 * compared against app_lineage.base_snapshot_id, the same comparison
 * computeDivergence makes for a single fork — NOT a proxy like "does this fork
 * have a base_release_id". That proxy is what silently misclassified every
 * live-cloned, up-to-date fork as the worst bucket in an earlier version of
 * this function: live clones have base_fingerprint set and base_release_id
 * NULL by design (see db/control-plane/109_template_releases.sql), so keying
 * "has a comparison anchor" off base_release_id alone was backwards.
 *
 * repo_latest_snapshot is runtime-tier and per-region, so it cannot be joined
 * from this control-plane query. Only forks that are actually behind need the
 * repo check, and those are batched into ONE query per region — bounded by
 * region count (~4), never by fork count. If a region's runtime DB is
 * unreachable, that region is recorded in `degraded_regions` and every behind
 * fork in it is counted in `unknown`, not guessed.
 *
 * A behind fork whose base_snapshot_id is NULL (pre-capture fork, no
 * trustworthy base at all — see the invariant above) has unknowable repo
 * state for the same reason and is also counted in `unknown`.
 *
 * Every fork lands in exactly one of current / behind_unmodified /
 * behind_modified / unknown, so the four always sum to `total`.
 */
export async function forkBuckets(
  controlDb: pg.Pool,
  sourceAppId: string,
  getRuntimePool: (region: string) => pg.Pool = (region) => getRuntimeDbPool(config.runtimeDb, region),
): Promise<ForkBuckets> {
  const lineageRes = await controlDb.query<ForkLineageForBucketing>(
    `SELECT l.dest_app_id, l.dest_region, l.base_release_id, l.base_snapshot_id, l.cloned_at,
            br.release_number AS base_release_number
       FROM app_lineage l
       LEFT JOIN template_releases br ON br.id = l.base_release_id
      WHERE l.source_app_id = $1 AND l.severed_at IS NULL`,
    [sourceAppId],
  );
  const forks = lineageRes.rows;
  const total = forks.length;
  if (total === 0) {
    return { total: 0, current: 0, behind_unmodified: 0, behind_modified: 0, unknown: 0, degraded_regions: [] };
  }

  const releasesRes = await controlDb.query<{ release_number: number; published_at: Date }>(
    `SELECT release_number, published_at
       FROM template_releases
      WHERE source_app_id = $1
      ORDER BY release_number DESC`,
    [sourceAppId],
  );
  const releases = releasesRes.rows;
  const latestNumber = releases.reduce((max, r) => Math.max(max, r.release_number), 0);

  const isBehind = (fork: ForkLineageForBucketing): boolean => {
    if (fork.base_release_id) {
      const baseNumber = fork.base_release_number ?? 0;
      return latestNumber > baseNumber;
    }
    return releases.some((r) => r.published_at > fork.cloned_at);
  };

  const behindForks = forks.filter(isBehind);
  const current = total - behindForks.length;

  // Only behind forks need a repo comparison; group them by region so each
  // region's runtime DB is hit at most once regardless of fork count.
  const byRegion = new Map<string, ForkLineageForBucketing[]>();
  for (const fork of behindForks) {
    const list = byRegion.get(fork.dest_region) ?? [];
    list.push(fork);
    byRegion.set(fork.dest_region, list);
  }

  const repoByAppId = new Map<string, string | null>();
  const degradedRegions: string[] = [];

  for (const [region, regionForks] of byRegion) {
    try {
      const pool = getRuntimePool(region);
      const ids = regionForks.map((f) => f.dest_app_id);
      const res = await pool.query<{ id: string; repo_latest_snapshot: string | null }>(
        `SELECT id, repo_latest_snapshot FROM apps WHERE id = ANY($1)`,
        [ids],
      );
      for (const row of res.rows) repoByAppId.set(row.id, row.repo_latest_snapshot);
    } catch {
      // Degrade this region rather than fail the whole call — see doc comment
      // for how its forks are counted below.
      degradedRegions.push(region);
    }
  }

  let behindUnmodified = 0;
  let behindModified = 0;
  let unknown = 0;
  for (const fork of behindForks) {
    const regionDegraded = degradedRegions.includes(fork.dest_region);
    // Unreachable region, or no trustworthy base_snapshot_id at all (pre-capture
    // fork): repo state cannot be determined. Report that as its own number
    // rather than guessing which of the other two buckets it belongs in.
    if (regionDegraded || fork.base_snapshot_id === null) {
      unknown++;
      continue;
    }
    // A missing `apps` row for this id (deleted app, replication lag) is the
    // same "cannot determine" case as an unreachable region — repoByAppId has
    // no entry for it, which the `?? null` below would otherwise treat as "no
    // snapshot" and silently compare unequal against a real base_snapshot_id.
    if (!repoByAppId.has(fork.dest_app_id)) {
      unknown++;
      continue;
    }
    const repoSnapshot = repoByAppId.get(fork.dest_app_id) ?? null;
    if (repoSnapshot === fork.base_snapshot_id) {
      behindUnmodified++;
    } else {
      behindModified++;
    }
  }

  return {
    total, current,
    behind_unmodified: behindUnmodified,
    behind_modified: behindModified,
    unknown,
    degraded_regions: degradedRegions,
  };
}
