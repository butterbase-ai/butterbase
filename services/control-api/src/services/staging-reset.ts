import type pg from 'pg';
import { getEnvironmentLink, touchEnvironmentTimestamp } from './app-environments.js';
import { replaySeedData } from './clone-replay.js';
import { isolateStagingApp, isolateStagingMeetingsWebhook } from './staging-isolation.js';
import { setCloneJobStatus, createCloneJob, type CloneJob } from './clone-jobs.js';
import { getRuntimeDbForApp } from './region-resolver.js';

export interface ResetLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface ResetDeps {
  /** Control-tier pool: template_clone_jobs lives here. */
  controlDb: pg.Pool;
  /**
   * Regional runtime pool. `apps` and `app_environments` are both
   * runtime-tier tables, and staging is pinned to production's region
   * (start-staging.ts), so ONE pool serves both apps here.
   */
  runtimeDb: pg.Pool;
  /** Per-app database of the PRODUCTION app — the source of the re-seed. */
  prodPool: pg.Pool;
  /** Per-app database of the STAGING app — the destination of the re-seed. */
  stagingPool: pg.Pool;
  /**
   * The neon_tasks attempt counters for this run (`task.attempts` /
   * `task.max_attempts`). Decide whether a failure is permanent — see the
   * catch block, which mirrors executePromote's / executeUpdate's retry
   * contract: 'failed' is written only once the queue has exhausted its
   * attempts, so a transient blip on attempt 1 of N does not turn the
   * remaining attempts into silent no-ops (isTerminalCloneStatus
   * short-circuits any resumed job whose status is already terminal).
   */
  attempt: number;
  maxAttempts: number;
  logger: ResetLogger;
}

export async function startStagingReset(args: {
  controlDb: pg.Pool; prodAppId: string; userId: string; orgId: string;
}): Promise<
  | { ok: true; jobId: string; stagingAppId: string }
  | { ok: false; code: 'NO_STAGING'; message: string }
> {
  const { controlDb, prodAppId, userId, orgId } = args;

  // getRuntimeDbForApp returns the regional pg.Pool directly (not
  // { pool, region }) — region-resolver.ts. The region string itself is
  // fetched separately below via the apps row, matching startPromote's
  // pattern in promote-jobs.ts.
  const runtimeDb = await getRuntimeDbForApp(controlDb, prodAppId);

  const link = await getEnvironmentLink(runtimeDb, prodAppId);
  if (!link) {
    return {
      ok: false,
      code: 'NO_STAGING',
      message: 'This app has no staging environment to reset.',
    };
  }

  const prodRow = (
    await runtimeDb.query<{ region: string }>(
      `SELECT region FROM apps WHERE id = $1`, [prodAppId],
    )
  ).rows[0];
  if (!prodRow) {
    return { ok: false, code: 'NO_STAGING', message: 'Production app not found.' };
  }

  // Direction: sourceAppId is the PRODUCTION app, matching job.source_app_id
  // for every reset job (see executeStagingReset below and
  // resolveCloneDispatch's routing in neon-task-worker.ts). This is the
  // opposite of startPromote, whose source is the staging app — reset flows
  // production -> staging, every other clone-family job flows the other way.
  // source_snapshot_id is deliberately NULL: a reset never touches the repo
  // (no 'repo'/'frontend' step exists in executeStagingReset), so there is
  // nothing real to pin, and the column has allowed NULL since migration 117.
  const job = await createCloneJob(controlDb, {
    sourceAppId: prodAppId,
    sourceSnapshotId: null,
    sourceRegion: prodRow.region,
    destRegion: prodRow.region,
    requestedByUserId: userId,
    destOrganizationId: orgId,
  });

  // createCloneJob's INSERT does not set mode or dest_app_id (both default:
  // mode='clone', dest_app_id=NULL) — same follow-up UPDATE shape as
  // startPromote (promote-jobs.ts) and start-staging.ts. dest_app_id is the
  // STAGING app: reset writes onto staging, never onto the production
  // source.
  await controlDb.query(
    `UPDATE template_clone_jobs SET mode = 'staging_reset', dest_app_id = $2 WHERE id = $1`,
    [job.id, link.staging_app_id],
  );

  return { ok: true, jobId: job.id, stagingAppId: link.staging_app_id };
}

/**
 * Re-seeds the staging app from production.
 *
 * DIRECTION IS REVERSED FROM PROMOTE. Every other job in this feature flows
 * staging -> production; this one flows production -> staging. On a reset
 * job, job.source_app_id is the PRODUCTION app and job.dest_app_id is the
 * STAGING app — the opposite of a promote job, where source = staging and
 * dest = production. Swapping the two pg.Pool arguments to replaySeedData
 * below would overwrite a customer's LIVE PRODUCTION DATA with staging's —
 * unrecoverable data loss. The assignment below asserts the direction
 * explicitly (not just via argument position) so a future edit cannot
 * silently invert it: prodAppId/stagingAppId are read from named CloneJob
 * fields and the pools passed to replaySeedData are named prodPool/
 * stagingPool from ResetDeps, not renamed or destructured positionally.
 *
 * Never writes to production: no schema/RLS/functions/config/repo/frontend
 * step exists here (contrast execute-promote.ts) — only the staging app's
 * per-app database and the staging isolation tables are touched.
 */
export async function executeStagingReset(deps: ResetDeps, job: CloneJob): Promise<void> {
  const { controlDb, runtimeDb, prodPool, stagingPool, attempt, maxAttempts, logger } = deps;
  const jobId = job.id;

  // Direction assertion: production is the SOURCE, staging is the
  // DESTINATION. Named explicitly rather than trusting call-site argument
  // order — see the function doc comment above.
  const prodAppId = job.source_app_id;
  const stagingAppId = job.dest_app_id;
  if (!stagingAppId) {
    throw new Error(`Reset job ${jobId} has no dest_app_id (staging app)`);
  }

  try {
    await setCloneJobStatus(controlDb, jobId, { status: 'seeding_data' });

    // Direction is PRODUCTION -> STAGING. prodPool is always the first
    // argument, stagingPool always the second — matches replaySeedData's
    // (sourceAppPool, destAppPool, logger) signature exactly, with
    // "source" = production and "dest" = staging for a reset.
    await replaySeedData(prodPool, stagingPool, logger);

    // Re-isolate: a fresh copy of production carries production's connected
    // accounts, enabled integrations and enabled cron triggers back into
    // staging. Must run AFTER the re-seed (not before) — isolating first
    // would only be immediately undone by the rows replaySeedData just
    // copied in. Same two calls, same order, as finalizeStagingClone
    // (staging-completion.ts) uses after a staging_create clone.
    await isolateStagingApp(runtimeDb, stagingAppId);
    await isolateStagingMeetingsWebhook(controlDb, stagingAppId);

    // Keyed on the PRODUCTION app id: app_environments.prod_app_id is the
    // table's primary key (touchEnvironmentTimestamp / app_environments.ts).
    await touchEnvironmentTimestamp(runtimeDb, prodAppId, 'last_reset_at');

    await setCloneJobStatus(controlDb, jobId, { status: 'completed', completed_at: new Date() });
    logger.info({ jobId, prodAppId, stagingAppId }, '[staging-reset] completed');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    // Attempt-gated, matching executePromote and executeUpdate: 'failed' is
    // written only once the neon_tasks queue has exhausted its attempts.
    // Marking failed on attempt 1 of N would make every remaining attempt a
    // silent no-op, because 'failed' is a terminal status the re-entry guard
    // in the worker short-circuits on.
    const isPermanent = attempt >= maxAttempts;
    if (isPermanent) {
      await setCloneJobStatus(controlDb, jobId, {
        status: 'failed', error_message: msg, completed_at: new Date(),
      }).catch(() => {});
      logger.error({ err, jobId, prodAppId, stagingAppId }, '[staging-reset] failed');
    } else {
      await setCloneJobStatus(controlDb, jobId, { error_message: msg }).catch(() => {});
      logger.warn(
        { jobId, prodAppId, stagingAppId, attempt, maxAttempts, error: msg },
        '[staging-reset] transient failure, will retry',
      );
    }
    throw err;
  }
}
