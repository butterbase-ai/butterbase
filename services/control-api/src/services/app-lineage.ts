import pg from 'pg';
import { captureAppState, type AppStateManifest } from './app-state-capture.js';

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

/**
 * Template-owner view. Three buckets, not two — this is the instrument that tells
 * us whether a merge engine has an audience before we build one.
 *
 * "Modified" here uses the repo signal only, which is a single column compare and
 * therefore safe to run across every fork. A per-fork backend introspect would
 * make this query unbounded.
 */
export async function forkBuckets(controlDb: pg.Pool, sourceAppId: string): Promise<ForkBuckets> {
  const res = await controlDb.query<{
    total: string; current: string; behind_unmodified: string; behind_modified: string;
  }>(
    `WITH latest AS (
       SELECT COALESCE(MAX(release_number), 0) AS n FROM template_releases WHERE source_app_id = $1
     ),
     forks AS (
       SELECT l.dest_app_id,
              COALESCE(br.release_number, 0) AS base_number,
              (l.base_snapshot_id IS NOT NULL AND l.base_release_id IS NOT NULL) AS has_base
         FROM app_lineage l
         LEFT JOIN template_releases br ON br.id = l.base_release_id
        WHERE l.source_app_id = $1 AND l.severed_at IS NULL
     )
     SELECT count(*)::text AS total,
            count(*) FILTER (WHERE base_number >= (SELECT n FROM latest))::text AS current,
            count(*) FILTER (WHERE base_number <  (SELECT n FROM latest) AND has_base)::text AS behind_unmodified,
            count(*) FILTER (WHERE base_number <  (SELECT n FROM latest) AND NOT has_base)::text AS behind_modified
       FROM forks`,
    [sourceAppId],
  );
  const r = res.rows[0];
  return {
    total: Number(r?.total ?? '0'),
    current: Number(r?.current ?? '0'),
    behind_unmodified: Number(r?.behind_unmodified ?? '0'),
    behind_modified: Number(r?.behind_modified ?? '0'),
  };
}
