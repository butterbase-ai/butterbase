/**
 * Admission gate for "may this promote start" — the last check before a
 * promote job runs against a customer's production app.
 *
 * Mirrors start-staging.ts: never touches `reply`, returns a result the
 * route (Task 15) maps to HTTP. Ordering is load-bearing: in-flight check →
 * resolve link → build preview → refuse if blocked → only then create the
 * job row. A refused promote must leave nothing behind — no job row, and no
 * occupied slot in idx_template_clone_jobs_one_promote — and the expensive
 * preview (introspects both databases) must not run until the cheap
 * in-flight check has passed.
 */
import type pg from 'pg';
import { getEnvironmentLink } from './app-environments.js';
import { createCloneJob, deleteCloneJob, type CloneJob } from './clone-jobs.js';
import { buildPromotePreview, formatBlockedStatements } from './promote-preview.js';
import { getAppPoolForApp } from './app-pool.js';
import { getRuntimeDbForApp } from './region-resolver.js';

export type StartPromoteResult =
  | { ok: true; jobId: string }
  | { ok: false; code: 'NO_STAGING' | 'BLOCKED' | 'IN_FLIGHT'; message: string };

/**
 * The in-flight promote for this production app, if any.
 *
 * Predicate must match idx_template_clone_jobs_one_promote (migration 116)
 * exactly: `mode = 'promote' AND status NOT IN ('completed','failed')`. A
 * partial unique index only enforces what its predicate describes — a
 * mismatch here would mean the guard and the index disagree about what
 * "in flight" means.
 */
export async function getActivePromoteJob(
  controlDb: pg.Pool,
  prodAppId: string,
): Promise<CloneJob | null> {
  const res = await controlDb.query<CloneJob>(
    `SELECT * FROM template_clone_jobs
      WHERE dest_app_id = $1 AND mode = 'promote'
        AND status NOT IN ('completed', 'failed')
      LIMIT 1`,
    [prodAppId],
  );
  return res.rows[0] ?? null;
}

export async function startPromote(args: {
  controlDb: pg.Pool;
  prodAppId: string;
  userId: string;
  orgId: string;
}): Promise<StartPromoteResult> {
  const { controlDb, prodAppId, userId, orgId } = args;

  // Cheap check first: no point resolving the link or introspecting two
  // databases if a promote for this app is already running.
  if (await getActivePromoteJob(controlDb, prodAppId)) {
    return {
      ok: false,
      code: 'IN_FLIGHT',
      message: 'A promote is already running for this app. Wait for it to finish.',
    };
  }

  // getRuntimeDbForApp returns the regional pg.Pool directly (not
  // { pool, region }) — region-resolver.ts:79-85. app_environments and apps
  // both live in that regional runtime DB.
  const runtimeDb = await getRuntimeDbForApp(controlDb, prodAppId);

  const link = await getEnvironmentLink(runtimeDb, prodAppId);
  if (!link) {
    return {
      ok: false,
      code: 'NO_STAGING',
      message: 'This app has no staging environment to promote from.',
    };
  }

  // Staging is pinned to the production app's region (start-staging.ts), so
  // both rows live in this same runtimeDb.
  const prodRow = (
    await runtimeDb.query<{ db_name: string; region: string }>(
      `SELECT db_name, region FROM apps WHERE id = $1`,
      [prodAppId],
    )
  ).rows[0];
  if (!prodRow) {
    return { ok: false, code: 'NO_STAGING', message: 'Production app not found.' };
  }
  const stagingRow = (
    await runtimeDb.query<{ db_name: string }>(
      `SELECT db_name FROM apps WHERE id = $1`,
      [link.staging_app_id],
    )
  ).rows[0];
  if (!stagingRow) {
    return { ok: false, code: 'NO_STAGING', message: 'Staging app not found.' };
  }

  const stagingPool = await getAppPoolForApp(controlDb, link.staging_app_id, stagingRow.db_name);
  const prodPool = await getAppPoolForApp(controlDb, prodAppId, prodRow.db_name);

  // Preview runs before the job row exists: a refused promote must leave no
  // trace to clean up, and must never occupy the one-in-flight index slot.
  // ignoredRemovals is informational only and must not affect canPromote.
  const preview = await buildPromotePreview(stagingPool, prodPool);
  if (!preview.canPromote) {
    return { ok: false, code: 'BLOCKED', message: formatBlockedStatements(preview.blocked) };
  }

  // createCloneJob's INSERT does not set mode or dest_app_id (both default:
  // mode='clone', dest_app_id=NULL) — set here, same shape as start-staging.ts's
  // post-clone UPDATE. This is the one point in the sequence where every
  // refusal path has already been passed, so it is the earliest safe place
  // to write.
  const job = await createCloneJob(controlDb, {
    sourceAppId: link.staging_app_id,
    sourceSnapshotId: `promote:${link.staging_app_id}:${Date.now()}`,
    sourceRegion: prodRow.region,
    destRegion: prodRow.region,
    requestedByUserId: userId,
    destOrganizationId: orgId,
  });

  try {
    await controlDb.query(
      `UPDATE template_clone_jobs SET mode = 'promote', dest_app_id = $2 WHERE id = $1`,
      [job.id, prodAppId],
    );
  } catch (err) {
    // A concurrent request can pass the getActivePromoteJob precheck above
    // before either has written mode='promote' — the read-then-write is not
    // atomic. idx_template_clone_jobs_one_promote is what actually enforces
    // "at most one in-flight promote per app"; this UPDATE is where a losing
    // racer's insert becomes visible to it as a 23505. Compensate by
    // deleting the just-created row (deleteCloneJob) rather than leaving a
    // stray mode='clone' job around for the worker to find — the same
    // orphaned-pending-job shape Task 4's startClone produced.
    if (
      (err as { code?: string })?.code === '23505' &&
      (err as { constraint?: string })?.constraint === 'idx_template_clone_jobs_one_promote'
    ) {
      await deleteCloneJob(controlDb, job.id);
      return {
        ok: false,
        code: 'IN_FLIGHT',
        message: 'A promote is already running for this app. Wait for it to finish.',
      };
    }
    throw err;
  }

  return { ok: true, jobId: job.id };
}
