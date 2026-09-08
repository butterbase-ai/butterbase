import { randomBytes } from 'crypto';
import type pg from 'pg';
import { getRuntimeDbPool } from './runtime-db.js';
import { config } from '../config.js';

/**
 * The bridge between the staging pipeline (this repo) and the app-copy engine
 * (`cloud/overlays/app-copy/`, internal).
 *
 * WHY A BRIDGE AND NOT A COPY ENGINE. `executeCopyJob` already copies exactly
 * what staging was missing — app rows in foreign-key order, `app_users` with
 * their password hashes, `storage_objects` AND their bytes, and the
 * platform-tier per-user rows. It lives in the overlay because
 * `docs/superpowers/specs/2026-09-05-app-data-copy-design.md` section 5 records
 * it as an internal operations tool that "does not belong in the open-source
 * distribution", and because it imports FROM `@butterbase/control-api/dist/...`.
 * The dependency runs internal -> OSS and never the reverse, so this file
 * cannot call the engine. What it CAN do is write the engine's queue row: the
 * staging path ENQUEUES an app_copy_jobs record and the overlay worker
 * (`startAppCopyWorker`, already wired in index.ts) claims and executes it.
 * That is the only direction the dependency graph permits, and it means there
 * is one copy engine rather than two that drift.
 *
 * The plan is NOT built here. `buildCopyPlan` is engine code too (it topo-sorts
 * the schema and value-probes for user-referencing columns). The row is
 * enqueued with `options.autoPlan = true` and an empty plan; the overlay
 * executor builds the plan at preflight, persists it onto the job row, and
 * replays it exactly as it replays an operator-approved one.
 */

/** Mirrors cloud/overlays/app-copy/jobs.ts:newCopyJobId — 'ac_' + 24 url-safe chars. */
export function newCopyJobId(): string {
  return 'ac_' + randomBytes(18).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/**
 * Options written onto the enqueued job.
 *
 * `companions` is deliberately empty. `app_subscriptions`, `app_orders` and
 * `app_user_activity_daily` are opt-in in the engine and default off — billing
 * and analytics history belong to the production app, and a staging app that
 * carried them would show a fabricated revenue history. Everything else the
 * engine can carry is carried.
 */
export const STAGING_COPY_OPTIONS = Object.freeze({
  autoPlan: true,
  origin: 'staging',
  skipUsers: false,
  skipStorage: false,
  companions: {},
});

/**
 * What the create/reset job records when the deployment has no app-copy engine.
 *
 * Degrading rather than failing is deliberate: an OSS deployment has no
 * `app_copy_jobs` table and no overlay worker, and refusing to create a staging
 * environment there would be a regression for every user of the open-source
 * distribution. What it must not do is degrade SILENTLY — seed-only staging is
 * the exact behaviour the product claim was wrong about, so it is named on the
 * job the user can actually read.
 */
export const COPY_UNSUPPORTED_WARNING =
  'Production data was NOT copied into staging. This deployment has no app-copy engine '
  + '(the app_copy_jobs table is absent), so staging was populated only from the tables '
  + 'your schema marks _seed:true. Production rows, auth users and uploaded files are not '
  + 'present in staging.';

/**
 * HOW AN OSS-ONLY DEPLOYMENT IS DETECTED: probe for the table.
 *
 * Three candidates were considered.
 *   - A config flag. Rejected: it is a second source of truth that can be set
 *     wrong in either direction, and being wrong in the "yes we have it"
 *     direction enqueues rows into a table that does not exist, mid-clone.
 *   - A capability registry. Rejected: none exists, and inventing one to hold a
 *     single boolean is more machinery than the question deserves.
 *   - `to_regclass` on the table. Chosen: `app_copy_jobs` is created by
 *     control-plane migration 112, which lives in the CLOUD repo's migration
 *     directory and is not part of the OSS migration set. Its presence is
 *     therefore exactly, and by construction, "this deployment ships the
 *     app-copy engine" — the same fact, not a restatement of it that can
 *     disagree.
 *
 * What the probe canNOT prove is that a worker is running to claim the row.
 * Nothing readable from here can. That gap is closed on the other side, by
 * `classifyStagingCopyWait`'s claim timeout: a job that is never claimed fails
 * the staging job with a message that names the missing worker, rather than
 * waiting forever.
 *
 * Cached per process after the first successful probe. The answer is a property
 * of the deployment's schema, which does not change without a restart, and this
 * is called on a path (executeClone) that must not add a round trip per job.
 * A FAILED probe is deliberately not cached: a transient control-DB blip would
 * otherwise pin the process to "OSS mode" and silently seed-only every staging
 * app until the next deploy.
 */
let copyEngineAvailable: boolean | null = null;

export async function isAppCopyEngineAvailable(controlDb: pg.Pool): Promise<boolean> {
  if (copyEngineAvailable !== null) return copyEngineAvailable;
  const res = await controlDb.query<{ reg: string | null }>(
    `SELECT to_regclass('public.app_copy_jobs')::text AS reg`,
  );
  copyEngineAvailable = res.rows[0]?.reg != null;
  return copyEngineAvailable;
}

/** Test seam only — production code never calls this. */
export function __resetAppCopyEngineCache(): void {
  copyEngineAvailable = null;
}

export type EnqueueCopyResult =
  | { ok: true; copyJobId: string }
  | { ok: false; reason: 'unsupported' | 'already_active'; message: string };

/**
 * Writes one prod -> staging row into the engine's queue.
 *
 * Runs on the control-plane Pool, never on an in-transaction client: the clone
 * pipeline has already committed by the time this is called, and the overlay
 * worker polls this table from another connection — a row written inside an
 * open transaction would be invisible to it for as long as that transaction
 * lived.
 *
 * mode is always 'copy'. 'move' relocates the source app's users and files,
 * which for a staging environment would empty PRODUCTION.
 *
 * Same region on both sides by construction: staging is pinned to production's
 * region at admission (start-staging.ts), so one region parameter fills both
 * columns and the engine's cross-region paths are never entered.
 */
export async function enqueueStagingDataCopy(args: {
  controlDb: pg.Pool;
  prodAppId: string;
  stagingAppId: string;
  region: string;
  requestedByUserId: string;
}): Promise<EnqueueCopyResult> {
  const { controlDb, prodAppId, stagingAppId, region, requestedByUserId } = args;

  if (prodAppId === stagingAppId) {
    throw new Error(
      `[staging-data-copy] refusing to enqueue: source (${prodAppId}) equals destination`,
    );
  }
  if (!(await isAppCopyEngineAvailable(controlDb))) {
    return { ok: false, reason: 'unsupported', message: COPY_UNSUPPORTED_WARNING };
  }

  const id = newCopyJobId();
  try {
    await controlDb.query(
      `INSERT INTO app_copy_jobs
         (id, source_app_id, dest_app_id, source_region, dest_region, mode,
          plan, options, requested_by_user_id)
       VALUES ($1, $2, $3, $4, $4, 'copy', '{}'::jsonb, $5::jsonb, $6)`,
      [id, prodAppId, stagingAppId, region, JSON.stringify(STAGING_COPY_OPTIONS),
        requestedByUserId],
    );
  } catch (err) {
    // Scoped to the ACTIVE-jobs partial unique index by NAME, exactly as
    // createCopyJob does. A bare 23505 would report any other unique violation
    // on this table as "a copy is already running", which is both wrong and
    // unactionable.
    const e = err as { code?: string; constraint?: string };
    if (e.code === '23505' && e.constraint === 'idx_app_copy_jobs_active') {
      // ADOPT rather than fail. The only way to reach this on the staging path
      // is a resumed staging job whose earlier attempt already enqueued a copy
      // (executeClone is re-entrant, and the enqueue is not the last write it
      // makes). Reporting "already running" would fail a job whose copy is
      // running perfectly well, so the enqueue is idempotent: the existing
      // active row for this exact pair IS this job's copy.
      const active = await controlDb.query<{ id: string }>(
        `SELECT id FROM app_copy_jobs
          WHERE source_app_id = $1 AND dest_app_id = $2
            AND status IN ('pending', 'processing')`,
        [prodAppId, stagingAppId],
      );
      if (active.rows[0]) return { ok: true, copyJobId: active.rows[0].id };
      // The conflicting row went terminal between the INSERT and this SELECT.
      // Nothing to adopt and nothing enqueued: report it rather than return a
      // job id that does not exist.
      return {
        ok: false,
        reason: 'already_active',
        message: `A data copy from ${prodAppId} to ${stagingAppId} conflicted with a `
          + 'concurrent one that has since finished. Retry.',
      };
    }
    throw err;
  }
  return { ok: true, copyJobId: id };
}

export interface CopyJobSnapshot {
  id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'aborted';
  phase: string | null;
  error_message: string | null;
  result: { reconnect?: { email: string; toolkit: string }[] } | null;
  created_at: Date;
  started_at: Date | null;
}

export async function getStagingDataCopy(
  controlDb: pg.Pool, copyJobId: string,
): Promise<CopyJobSnapshot | null> {
  const res = await controlDb.query<CopyJobSnapshot>(
    `SELECT id, status, phase, error_message, result, created_at, started_at
       FROM app_copy_jobs WHERE id = $1`,
    [copyJobId],
  );
  return res.rows[0] ?? null;
}

/**
 * How long a copy job may sit unclaimed before we conclude no worker exists.
 *
 * The table probe proves the SCHEMA ships the engine; it cannot prove a worker
 * is running. This is the other half of that answer. Generous by default —
 * the overlay worker polls every 2s, so ten minutes unclaimed is not a busy
 * queue, it is an absent one.
 */
export const COPY_CLAIM_TIMEOUT_MS =
  Number(process.env.BUTTERBASE_STAGING_COPY_CLAIM_TIMEOUT_MS ?? 10 * 60 * 1000);

/**
 * Total wall-clock budget for the copy. A large app moving storage bytes is
 * genuinely slow (the app-copy design names storage as the only phase slow in
 * wall-clock terms), so this is hours, not minutes. It exists so a wedged copy
 * eventually reports `failed` instead of leaving a staging job in
 * `copying_data` forever.
 */
export const COPY_TOTAL_TIMEOUT_MS =
  Number(process.env.BUTTERBASE_STAGING_COPY_TIMEOUT_MS ?? 6 * 60 * 60 * 1000);

/** How long the wait task sleeps between polls of the copy job. */
export const COPY_POLL_INTERVAL_MS = 10_000;

export type CopyWaitVerdict =
  | { kind: 'waiting' }
  | { kind: 'done' }
  | { kind: 'failed'; message: string };

/**
 * Pure decision function for the wait task, so both timeouts are testable
 * without a queue, a worker or a clock.
 *
 * `aborted` is treated as a failure of the STAGING job on purpose. An operator
 * aborting the copy from the app-copy console has decided this staging app
 * should not hold production's data; completing the staging job anyway would
 * hand the user a half-populated environment described as ready.
 */
export function classifyStagingCopyWait(args: {
  copy: Pick<
    CopyJobSnapshot, 'status' | 'phase' | 'created_at' | 'started_at' | 'error_message'
  > | null;
  now: Date;
  claimTimeoutMs?: number;
  totalTimeoutMs?: number;
}): CopyWaitVerdict {
  const claimTimeoutMs = args.claimTimeoutMs ?? COPY_CLAIM_TIMEOUT_MS;
  const totalTimeoutMs = args.totalTimeoutMs ?? COPY_TOTAL_TIMEOUT_MS;
  const copy = args.copy;

  if (!copy) {
    return {
      kind: 'failed',
      message: 'The data-copy job this staging job was waiting on no longer exists. '
        + 'Staging holds schema and seed data only; delete it and create it again.',
    };
  }
  if (copy.status === 'completed') return { kind: 'done' };
  if (copy.status === 'failed' || copy.status === 'aborted') {
    return {
      kind: 'failed',
      message: `The production data copy ${copy.status === 'aborted' ? 'was aborted' : 'failed'}`
        + `${copy.phase ? ` during the ${copy.phase} phase` : ''}: `
        + `${copy.error_message ?? 'no error recorded'}`,
    };
  }

  const ageMs = args.now.getTime() - new Date(copy.created_at).getTime();
  if (copy.status === 'pending' && ageMs > claimTimeoutMs) {
    return {
      kind: 'failed',
      message: 'No app-copy worker claimed the production data copy within '
        + `${Math.round(claimTimeoutMs / 60000)} minutes. The app_copy_jobs table exists on this `
        + 'deployment but nothing is processing it, so staging would have been reported ready '
        + 'holding schema and seed data only. Check that the app-copy worker is running.',
    };
  }
  if (ageMs > totalTimeoutMs) {
    return {
      kind: 'failed',
      message: 'The production data copy did not finish within '
        + `${Math.round(totalTimeoutMs / 3600000)} hour(s) (last phase: ${copy.phase ?? 'none'}). `
        + 'Staging is not a complete copy of production.',
    };
  }
  return { kind: 'waiting' };
}

/**
 * Re-arm the wait: one more 'clone' task on the region queue, delayed.
 *
 * A fresh neon_tasks ROW rather than a retry of the current one, because the
 * queue's `attempts`/`max_attempts` budget exists to bound genuine FAILURES.
 * Spending it on "the copy is still running" would give the wait a ceiling of
 * roughly a minute (BACKOFF_SECONDS tops out at 32s over five attempts) and
 * then permanently fail every staging environment big enough to take longer
 * than that.
 *
 * `idx_neon_tasks_active_unique_non_clone` covers only non-clone task types, so
 * successive clone rows for the same app coexist — the same property
 * enqueueCloneTask already relies on.
 */
export async function enqueueCopyWaitTask(args: {
  appId: string; region: string; jobId: string; delayMs?: number;
}): Promise<void> {
  const runtimePool = getRuntimeDbPool(config.runtimeDb, args.region);
  const delayMs = args.delayMs ?? COPY_POLL_INTERVAL_MS;
  await runtimePool.query(
    `INSERT INTO neon_tasks (app_id, task_type, task_meta, run_after)
     VALUES ($1, 'clone', $2, now() + ($3::int * interval '1 millisecond'))`,
    [args.appId, JSON.stringify({ job_id: args.jobId }), delayMs],
  );
}

/**
 * Warnings derived from a finished copy, appended to the staging job.
 *
 * The reconnect list is the one thing a completed copy still needs to say out
 * loud: `app_connected_accounts` rows travel marked `expired` and are then
 * DELETED outright by `isolateStagingApp`, so nobody's integrations work in
 * staging and the user should not discover that by clicking one.
 */
export function stagingCopyWarnings(copy: CopyJobSnapshot): string[] {
  const warnings: string[] = [];
  const reconnect = copy.result?.reconnect ?? [];
  if (reconnect.length > 0) {
    const toolkits = [...new Set(reconnect.map((r) => r.toolkit))].sort();
    warnings.push(
      `${reconnect.length} connected-account record(s) (${toolkits.join(', ')}) were copied from `
      + 'production and then cleared by staging isolation. Integrations are deliberately not '
      + 'live in staging: connect them again on the staging app if you need them.',
    );
  }
  return warnings;
}
