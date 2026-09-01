import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { captureAppState, type AppStateManifest } from './app-state-capture.js';

export interface TemplateRelease {
  id: string;
  source_app_id: string;
  release_number: number;
  label: string | null;
  snapshot_id: string;
  manifest: AppStateManifest;
  notes: string | null;
  published_by: string;
  published_at: Date;
}

export interface ReleaseSummary {
  release_number: number;
  label: string | null;
  notes: string | null;
  published_at: Date;
  table_count: number;
  function_names: string[];
  required_env: string[];
}

export class NoRepoSnapshotError extends Error {
  constructor(public readonly appId: string) {
    super(`App ${appId} has no repo snapshot`);
  }
}

function generateReleaseId(): string {
  return 'rel_' + randomBytes(18).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/**
 * Public-safe projection. Anonymous callers get counts, function NAMES, and
 * required env KEY NAMES — never function bodies, schema DSL, or policy text.
 * "Anyone could clone it anyway" is nearly true and not a good enough basis for
 * serving source code to unauthenticated callers.
 */
export function summarizeRelease(r: TemplateRelease): ReleaseSummary {
  const m = r.manifest;
  const envKeys = new Set<string>();
  for (const keys of Object.values(m.required_env?.functions ?? {})) {
    for (const k of keys) envKeys.add(k);
  }
  for (const k of m.required_env?.durable_objects ?? []) envKeys.add(k);
  return {
    release_number: r.release_number,
    label: r.label,
    notes: r.notes,
    published_at: r.published_at,
    table_count: Object.keys(m.schema?.tables ?? {}).length,
    function_names: (m.functions ?? []).map((f) => f.name),
    required_env: [...envKeys].sort(),
  };
}

/**
 * Capture and publish. Read-only against the source app apart from the
 * latest_release_number pointer. Synchronous — an introspect plus a handful of
 * queries — so there is no job queue, no neon_tasks type, no reaper.
 *
 * The advisory lock serializes concurrent publishes for one template so that
 * MAX(release_number)+1 cannot race into a unique-constraint violation.
 */
export async function publishRelease(
  controlDb: pg.Pool,
  runtimePool: pg.Pool,
  appPool: pg.Pool,
  args: { sourceAppId: string; publishedBy: string; label: string | null; notes: string | null },
): Promise<TemplateRelease> {
  const manifest = await captureAppState(runtimePool, appPool, args.sourceAppId);
  if (!manifest.snapshot_id) throw new NoRepoSnapshotError(args.sourceAppId);

  const client = await controlDb.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [args.sourceAppId]);

    const maxRow = await client.query<{ max: number | null }>(
      `SELECT MAX(release_number) AS max FROM template_releases WHERE source_app_id = $1`,
      [args.sourceAppId],
    );
    const next = (maxRow.rows[0]?.max ?? 0) + 1;

    const inserted = await client.query<TemplateRelease>(
      `INSERT INTO template_releases
         (id, source_app_id, release_number, label, snapshot_id, manifest, notes, published_by)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
       RETURNING *`,
      [generateReleaseId(), args.sourceAppId, next, args.label,
       manifest.snapshot_id, JSON.stringify(manifest), args.notes, args.publishedBy],
    );

    await client.query('COMMIT');

    // Denormalized pointer for discovery. Best-effort: the control-plane row is
    // the source of truth, so a failure here is cosmetic, not corrupting.
    await runtimePool.query(
      `UPDATE apps SET latest_release_number = $1, updated_at = now() WHERE id = $2`,
      [next, args.sourceAppId],
    ).catch(() => {});

    return inserted.rows[0];
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function listReleases(
  controlDb: pg.Pool, sourceAppId: string, limit = 50,
): Promise<TemplateRelease[]> {
  const res = await controlDb.query<TemplateRelease>(
    `SELECT * FROM template_releases WHERE source_app_id = $1
      ORDER BY release_number DESC LIMIT $2`,
    [sourceAppId, Math.min(Math.max(limit, 1), 100)],
  );
  return res.rows;
}

export async function getRelease(
  controlDb: pg.Pool, sourceAppId: string, releaseNumber: number,
): Promise<TemplateRelease | null> {
  const res = await controlDb.query<TemplateRelease>(
    `SELECT * FROM template_releases WHERE source_app_id = $1 AND release_number = $2`,
    [sourceAppId, releaseNumber],
  );
  return res.rows[0] ?? null;
}

/** Releases are insert-only; only display text is mutable. */
export async function updateReleaseText(
  controlDb: pg.Pool, sourceAppId: string, releaseNumber: number,
  fields: { label?: string | null; notes?: string | null },
): Promise<TemplateRelease | null> {
  const res = await controlDb.query<TemplateRelease>(
    `UPDATE template_releases
        SET label = COALESCE($3, label), notes = COALESCE($4, notes)
      WHERE source_app_id = $1 AND release_number = $2
      RETURNING *`,
    [sourceAppId, releaseNumber, fields.label ?? null, fields.notes ?? null],
  );
  return res.rows[0] ?? null;
}

/**
 * Snapshot ids pinned by this app's published releases — the caller adds them to
 * planRetention's pinned set.
 *
 * A release is a promise that a specific snapshot stays fetchable: forks resolve
 * it at update time, potentially months later. Retention keeps only the newest
 * REPO_RETAIN_SNAPSHOTS, and the pinned set previously held just the incoming
 * snapshot plus in-flight clones — so publishing a release and then pushing five
 * more commits deleted the snapshot that release pointed at, together with any
 * blobs nothing else referenced. Nothing failed at push time. The release row
 * survived, referencing bytes that no longer existed, and every fork updating
 * from it died on "Source manifest not found".
 */
export async function listReleaseSnapshotIdsForApp(
  controlDb: pg.Pool,
  sourceAppId: string,
): Promise<Set<string>> {
  const res = await controlDb.query<{ snapshot_id: string }>(
    `SELECT snapshot_id FROM template_releases WHERE source_app_id = $1`,
    [sourceAppId],
  );
  return new Set(res.rows.map(r => r.snapshot_id));
}
