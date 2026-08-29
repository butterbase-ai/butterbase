import pg from 'pg';
import { randomBytes } from 'crypto';
import { encrypt } from './crypto.js';
import type { AppStateManifest } from './app-state-capture.js';

export type CloneJobStatus =
  | 'pending'
  | 'processing'
  | 'replaying_schema'
  | 'replaying_rls'
  | 'replaying_durable_objects'
  | 'replaying_functions'
  | 'replaying_config'
  | 'copying_repo'
  | 'seeding_data'
  | 'completed'
  | 'failed';

/**
 * Statuses at which the pipeline is finished for good. Any other status —
 * including mid-flight ones like 'replaying_rls' — is resumable and must NOT
 * short-circuit executeClone on retry (see neon-task-worker.ts). A prior
 * version of the re-entry guard treated everything except 'pending'/'processing'
 * as terminal, which silently orphaned jobs after their first mid-stage crash.
 */
export const TERMINAL_CLONE_STATUSES: ReadonlyArray<CloneJobStatus> = ['completed', 'failed'];

export function isTerminalCloneStatus(status: CloneJobStatus): boolean {
  return TERMINAL_CLONE_STATUSES.includes(status);
}

export interface CloneJob {
  id: string;
  source_app_id: string;
  source_snapshot_id: string;
  source_region: string;
  dest_app_id: string | null;
  dest_region: string;
  requested_by_user_id: string;
  dest_organization_id: string | null;
  dest_app_name: string | null;
  status: CloneJobStatus;
  retry_count: number;
  error_message: string | null;
  warnings: string[] | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
  pending_env_vars: string | null;       // encrypted JSON blob (AUTH_ENCRYPTION_KEY)
  auto_mint_requests: { fn_name: string; key: string }[] | null;
  unfilled_env_vars: Record<string, string[]> | null;
  mode: 'clone' | 'update';
  target_release_id: string | null;
  pre_sync_snapshot_id: string | null;
  pre_sync_lineage: PreSyncLineage | null;
}

/**
 * Everything about the fork that an update overwrites and undo must put back.
 *
 * The repo pointer alone is not enough: executeUpdate's final step advances
 * app_lineage to the new release, and computeDivergence compares
 * apps.repo_latest_snapshot against app_lineage.base_snapshot_id. Restoring one
 * without the other leaves the fork reading as user-modified forever. The
 * manifest is the fork's pre-update captureAppState output, which carries
 * function bodies, so undo can restore those too.
 */
export interface PreSyncLineage {
  base_release_id: string | null;
  base_fingerprint: AppStateManifest | null;
  base_snapshot_id: string | null;
  manifest: AppStateManifest | null;
}

function generateJobId(): string {
  // 'cj_' + 24 url-safe chars (base64url, no padding)
  return 'cj_' + randomBytes(18).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

export async function createCloneJob(
  controlDb: pg.Pool,
  args: {
    sourceAppId: string;
    sourceSnapshotId: string;
    sourceRegion: string;
    destRegion: string;
    requestedByUserId: string;
    destOrganizationId: string;
    destAppName?: string;
    pendingEnvVarValues?: Record<string, Record<string, string>>;
    autoMintRequests?: { fn_name: string; key: string }[];
  },
): Promise<CloneJob> {
  const id = generateJobId();

  let pendingEnvVars: string | null = null;
  if (args.pendingEnvVarValues && Object.keys(args.pendingEnvVarValues).length > 0) {
    const keyHex = process.env.AUTH_ENCRYPTION_KEY;
    if (!keyHex) throw new Error('AUTH_ENCRYPTION_KEY not configured');
    pendingEnvVars = encrypt(JSON.stringify(args.pendingEnvVarValues), keyHex);
  }

  let autoMintRequests: string | null = null;
  if (args.autoMintRequests && args.autoMintRequests.length > 0) {
    autoMintRequests = JSON.stringify(args.autoMintRequests);
  }

  const res = await controlDb.query<CloneJob>(
    `INSERT INTO template_clone_jobs
       (id, source_app_id, source_snapshot_id, source_region, dest_region,
        requested_by_user_id, dest_organization_id, dest_app_name,
        pending_env_vars, auto_mint_requests)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      id,
      args.sourceAppId,
      args.sourceSnapshotId,
      args.sourceRegion,
      args.destRegion,
      args.requestedByUserId,
      args.destOrganizationId,
      args.destAppName ?? null,
      pendingEnvVars,
      autoMintRequests,
    ],
  );
  return res.rows[0];
}

export async function getCloneJob(controlDb: pg.Pool, jobId: string): Promise<CloneJob | null> {
  const res = await controlDb.query<CloneJob>(`SELECT * FROM template_clone_jobs WHERE id = $1`, [jobId]);
  return res.rows[0] ?? null;
}

export async function setCloneJobStatus(
  controlDb: pg.Pool,
  jobId: string,
  patch: Partial<Pick<CloneJob, 'status' | 'dest_app_id' | 'error_message' | 'completed_at'>>,
): Promise<void> {
  const fields: string[] = ['updated_at = now()'];
  const values: unknown[] = [];
  let i = 1;
  for (const [k, v] of Object.entries(patch)) {
    fields.push(`${k} = $${i++}`);
    values.push(v);
  }
  values.push(jobId);
  await controlDb.query(
    `UPDATE template_clone_jobs SET ${fields.join(', ')} WHERE id = $${i}`,
    values,
  );
}

export async function incrementRetry(controlDb: pg.Pool, jobId: string): Promise<void> {
  await controlDb.query(
    `UPDATE template_clone_jobs
     SET retry_count = retry_count + 1, status = 'pending', error_message = NULL, updated_at = now()
     WHERE id = $1`,
    [jobId],
  );
}

export async function appendCloneJobWarnings(
  controlDb: pg.Pool,
  jobId: string,
  warnings: string[],
): Promise<void> {
  if (warnings.length === 0) return;
  await controlDb.query(
    `UPDATE template_clone_jobs
     SET warnings = COALESCE(warnings, '[]'::jsonb) || $1::jsonb
     WHERE id = $2`,
    [JSON.stringify(warnings), jobId],
  );
}

/**
 * Raised when the partial unique index idx_template_clone_jobs_one_update
 * rejects an insert because this fork already has an update in flight.
 *
 * The route's getActiveUpdateJob pre-check is a read-then-write, so two
 * concurrent requests can both clear it and race to the INSERT. The index is
 * what actually enforces "at most one in-flight update per fork" — but a raw
 * 23505 propagating out of here reaches the owner as a 500 INTERNAL_ERROR,
 * which reads as "Butterbase is broken" rather than "you clicked twice".
 * Translating it here lets the route answer with the same 409 the pre-check
 * would have given.
 */
export class UpdateJobConflictError extends Error {
  constructor(public readonly forkAppId: string) {
    super(`An update is already in progress for ${forkAppId}`);
    this.name = 'UpdateJobConflictError';
  }
}

/**
 * `preSyncSnapshotId` MUST be null at creation time.
 *
 * The worker writes it after the execution-time eligibility gate passes and
 * immediately before the first write the fork can observe, and then reads its
 * presence as "a prior attempt of this job already got past the gate"
 * (classifyUpdateResume in neon-task-worker.ts). A route that pre-fills it with
 * the fork's current snapshot would make every job look resumed on its very
 * first attempt, and the execution-time gate would never run for any job.
 *
 * The parameter exists only so a caller reconstructing a job row (a backfill,
 * a test) can supply the marker deliberately.
 */
export async function createUpdateJob(
  controlDb: pg.Pool,
  args: {
    forkAppId: string; forkRegion: string;
    sourceAppId: string; sourceRegion: string;
    targetReleaseId: string; sourceSnapshotId: string;
    requestedByUserId: string; preSyncSnapshotId: string | null;
  },
): Promise<CloneJob> {
  // dest_app_id must always be set on an update row: the partial unique index
  // idx_template_clone_jobs_one_update (dest_app_id, mode='update', status IN
  // ('pending','processing')) cannot enforce "at most one in-flight update per
  // fork" if dest_app_id is NULL — Postgres treats NULLs as distinct for
  // uniqueness. Reject here rather than let a NULL silently escape that guard.
  if (!args.forkAppId) {
    throw new Error('createUpdateJob requires a non-empty forkAppId (written to dest_app_id)');
  }

  const id = generateJobId();
  let res;
  try {
    res = await controlDb.query<CloneJob>(
      `INSERT INTO template_clone_jobs (
         id, mode, source_app_id, source_snapshot_id, source_region,
         dest_app_id, dest_region, requested_by_user_id,
         target_release_id, pre_sync_snapshot_id, status
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending')
       RETURNING *`,
      [id, 'update', args.sourceAppId, args.sourceSnapshotId, args.sourceRegion,
       args.forkAppId, args.forkRegion, args.requestedByUserId,
       args.targetReleaseId, args.preSyncSnapshotId],
    );
  } catch (err) {
    // 23505 on this specific index means a concurrent request won the race.
    // Any other unique violation is a real bug and must keep propagating.
    if (
      (err as { code?: string })?.code === '23505' &&
      (err as { constraint?: string })?.constraint === 'idx_template_clone_jobs_one_update'
    ) {
      throw new UpdateJobConflictError(args.forkAppId);
    }
    throw err;
  }
  return res.rows[0];
}

/**
 * How long after an update job fails a retry still means "try that again".
 *
 * Retry is only safe while the fork is still in the state the job left it in.
 * There is no upper bound on how long an owner may keep working on a fork after
 * an update fails, and the execution-time gate cannot always tell their edits
 * from a prior attempt's writes (see classifyUpdateResume's 'republish' branch,
 * which by design skips divergence checks). A time bound is the cheap way to
 * keep the retry path inside the window where that assumption holds.
 */
export const UPDATE_RETRY_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

export type UpdateRetryRefusal = 'superseded' | 'stale';

/**
 * May this failed update job be retried?
 *
 * Snapshot ids are content hashes, so two jobs targeting the same release on the
 * same fork compute the SAME target snapshot. That makes a stale retry
 * dangerous: job A fails after publishing the repo, job B completes the update,
 * the owner then edits a function body — which leaves the repo HEAD untouched,
 * still equal to the target — and a retry of job A classifies as 'republish',
 * skips the divergence gate, and overwrites the edited function.
 *
 * Two independent guards, because either alone leaves a hole:
 *   - `superseded`: another update job for this fork has since completed, so
 *     this job is not the fork's current state and cannot be resumed into it.
 *   - `stale`: too much time has passed since the job last moved. Covers the
 *     case with no job B at all — an owner who edits functions in the weeks
 *     after a failed update, where nothing but the clock reveals the risk.
 *
 * Pure so both conditions are testable without a queue or a fork.
 */
export function canRetryUpdateJob(args: {
  lastUpdatedAt: Date;
  now: Date;
  hasNewerCompletedUpdate: boolean;
}): { allowed: boolean; reason: UpdateRetryRefusal | 'ok' } {
  if (args.hasNewerCompletedUpdate) return { allowed: false, reason: 'superseded' };
  if (args.now.getTime() - args.lastUpdatedAt.getTime() > UPDATE_RETRY_MAX_AGE_MS) {
    return { allowed: false, reason: 'stale' };
  }
  return { allowed: true, reason: 'ok' };
}

/** Has another update job for this fork completed since the given one was created? */
export async function hasNewerCompletedUpdate(
  controlDb: pg.Pool, forkAppId: string, jobId: string, createdAt: Date,
): Promise<boolean> {
  const res = await controlDb.query(
    `SELECT 1 FROM template_clone_jobs
      WHERE dest_app_id = $1 AND mode = 'update' AND id <> $2
        AND status = 'completed' AND created_at > $3
      LIMIT 1`,
    [forkAppId, jobId, createdAt],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * The in-flight update for this fork, if any.
 *
 * "In flight" is everything that is NOT terminal, not just pending/processing.
 * executeUpdate moves the job to 'copying_repo' before any gate and before a
 * long S3 copy; a narrower predicate let a second POST /update slip through
 * that window and run a second worker against the same fork, whose
 * pre_sync_snapshot_id then captured the first one's POST-update HEAD and made
 * its undo a no-op. Kept in lockstep with idx_template_clone_jobs_one_update
 * (migration 111), which uses the same set.
 */
export async function getActiveUpdateJob(
  controlDb: pg.Pool, forkAppId: string,
): Promise<CloneJob | null> {
  const res = await controlDb.query<CloneJob>(
    `SELECT * FROM template_clone_jobs
      WHERE dest_app_id = $1 AND mode = 'update'
        AND NOT (status = ANY($2::text[]))
      LIMIT 1`,
    [forkAppId, TERMINAL_CLONE_STATUSES],
  );
  return res.rows[0] ?? null;
}

/** Snapshot ids that an in-flight clone is reading from — caller adds them to planRetention's pinned set. */
export async function listActiveCloneSnapshotIdsForApp(
  controlDb: pg.Pool,
  sourceAppId: string,
): Promise<Set<string>> {
  const res = await controlDb.query<{ source_snapshot_id: string }>(
    `SELECT source_snapshot_id FROM template_clone_jobs
     WHERE source_app_id = $1 AND status IN ('pending', 'processing')`,
    [sourceAppId],
  );
  return new Set(res.rows.map(r => r.source_snapshot_id));
}

/**
 * Delete a job row outright. Compensation only, for a job that failed to
 * enqueue and therefore has never been observed by a worker — an un-enqueued
 * 'pending' update row is worse than no row, because getActiveUpdateJob reads
 * it as in flight and 409s every future update of that fork forever.
 */
export async function deleteCloneJob(controlDb: pg.Pool, jobId: string): Promise<void> {
  await controlDb.query(`DELETE FROM template_clone_jobs WHERE id = $1`, [jobId]);
}
