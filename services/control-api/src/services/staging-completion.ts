import type pg from 'pg';
import { linkEnvironments } from './app-environments.js';
import { isolateStagingApp, isolateStagingMeetingsWebhook } from './staging-isolation.js';
import type { CloneJob } from './clone-jobs.js';

/**
 * The two isolation calls, in the one order that is correct, behind one name.
 *
 * ISOLATION MUST RUN AFTER ANYTHING THAT COPIES PRODUCTION IN. A fresh copy of
 * production re-imports connected accounts, enabled integration configs and
 * enabled cron triggers; isolating before the copy simply hands those back.
 * That is why this is a named, re-runnable step rather than a line inside
 * `finalizeStagingClone`: the production-data copy finishes on a LATER task
 * than the clone (see staging-data-copy.ts), so the isolation has to happen
 * twice — once as soon as the app exists, to close the window while the copy
 * runs, and once after the copy lands, to neutralise what it brought.
 *
 * Every statement inside both calls is idempotent (DELETE of an already-empty
 * set, UPDATE of already-disabled rows, a re-check of an already-verified
 * webhook row), so calling it twice is exactly as safe as calling it once.
 */
export async function isolateStagingEnvironment(
  runtimeDb: pg.Pool, controlDb: pg.Pool, stagingAppId: string,
): Promise<void> {
  await isolateStagingApp(runtimeDb, stagingAppId);
  await isolateStagingMeetingsWebhook(controlDb, stagingAppId);
}

/**
 * The write that makes a staging pair first-class and visible in the dashboard.
 *
 * Split out from `finalizeStagingClone` because it is the LAST thing that
 * should happen, not merely one of them: until this row exists the app is not
 * a staging environment as far as `getEnvironmentLink` — and therefore reset,
 * promote and the dashboard panel — are concerned. When a production-data copy
 * is in flight, holding this back is what keeps a schema-only staging app from
 * appearing usable while it is still empty.
 */
export async function linkStagingEnvironment(
  runtimeDb: pg.Pool, job: CloneJob,
): Promise<void> {
  if (!job.dest_app_id) {
    throw new Error(`staging_create job ${job.id} has no dest_app_id`);
  }
  await linkEnvironments(runtimeDb, {
    prodAppId: job.source_app_id,
    stagingAppId: job.dest_app_id,
    createdBy: job.requested_by_user_id,
  });
}

/**
 * Called by executeClone once the destination app is fully provisioned. For a
 * staging_create job this is the write that makes the pair first-class; for
 * every other mode it is a no-op.
 *
 * Takes both the regional runtime Pool and the control-plane Pool — never an
 * in-transaction client for either: the clone pipeline has already committed
 * by this point and this write must not be able to roll the provision back.
 * The two pools are passed to distinct isolation calls rather than merged
 * into one, so it stays visible which plane each write lands on.
 *
 * Isolate before linking: until the pair is linked the staging app is not yet
 * visible as a staging environment, so this closes the window in which an
 * inherited connected account (or a stray production-pointed webhook) could
 * be used.
 *
 * This is the NO-DATA-COPY path — it completes the pair on the same task that
 * provisioned it. When a production-data copy is enqueued instead, executeClone
 * calls `isolateStagingEnvironment` here and defers `linkStagingEnvironment` to
 * the wait task that observes the copy finish.
 */
export async function finalizeStagingClone(runtimeDb: pg.Pool, controlDb: pg.Pool, job: CloneJob): Promise<void> {
  if (job.mode !== 'staging_create') return;
  if (!job.dest_app_id) {
    throw new Error(`staging_create job ${job.id} completed with no dest_app_id`);
  }
  await isolateStagingEnvironment(runtimeDb, controlDb, job.dest_app_id);
  await linkStagingEnvironment(runtimeDb, job);
}
