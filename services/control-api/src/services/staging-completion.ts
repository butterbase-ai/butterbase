import type pg from 'pg';
import { linkEnvironments } from './app-environments.js';
import { isolateStagingApp } from './staging-isolation.js';
import type { CloneJob } from './clone-jobs.js';

/**
 * Called by executeClone once the destination app is fully provisioned. For a
 * staging_create job this is the write that makes the pair first-class; for
 * every other mode it is a no-op.
 *
 * Runs on the regional runtime Pool, not on any in-transaction client: the
 * clone pipeline has already committed by this point and this write must not
 * be able to roll the provision back.
 */
export async function finalizeStagingClone(runtimeDb: pg.Pool, job: CloneJob): Promise<void> {
  if (job.mode !== 'staging_create') return;
  if (!job.dest_app_id) {
    throw new Error(`staging_create job ${job.id} completed with no dest_app_id`);
  }
  // Isolate before linking: until the pair is linked the staging app is not yet
  // visible as a staging environment, so this closes the window in which an
  // inherited connected account could be used.
  await isolateStagingApp(runtimeDb, job.dest_app_id);
  await linkEnvironments(runtimeDb, {
    prodAppId: job.source_app_id,
    stagingAppId: job.dest_app_id,
    createdBy: job.requested_by_user_id,
  });
}
