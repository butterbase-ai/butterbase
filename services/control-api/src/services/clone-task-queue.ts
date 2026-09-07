/**
 * Shared clone-task enqueue.
 *
 * Lifted out of `routes/clone.ts` so the clone route, the retry route and the
 * clone-intent redeem route all use one copy. It writes to a REGIONAL runtime
 * DB, not the control plane, so callers must invoke it only after the
 * control-plane work has committed, and never on an in-transaction PoolClient.
 */

import { getRuntimeDbPool } from './runtime-db.js';
import { config } from '../config.js';

/**
 * Insert a 'clone' row into the source app's region neon_tasks queue.
 *
 * Each clone job gets its own neon_tasks row.  The unique constraint
 * (idx_neon_tasks_active_unique_non_clone) applies only to non-clone task
 * types, so concurrent clone tasks for the same source app coexist safely.
 * The worker claims tasks with FOR UPDATE SKIP LOCKED and processes them
 * sequentially without interfering with sibling clone tasks.
 */
export async function enqueueCloneTask(
  sourceAppId: string,
  sourceRegion: string,
  jobId: string,
): Promise<void> {
  const runtimePool = getRuntimeDbPool(config.runtimeDb, sourceRegion);
  await runtimePool.query(
    `INSERT INTO neon_tasks (app_id, task_type, task_meta) VALUES ($1, 'clone', $2)`,
    [sourceAppId, JSON.stringify({ job_id: jobId })],
  );
}
