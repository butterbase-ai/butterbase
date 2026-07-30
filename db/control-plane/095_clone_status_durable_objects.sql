-- @scope: platform
-- 095: Extend template_clone_jobs.status with 'replaying_durable_objects'.
-- Corresponds to a new step in executeClone (neon-task-worker.ts) that copies
-- app_durable_objects rows from source to dest and re-runs bundleAndDeploy on
-- the dest namespace. Prior to this migration, DO classes silently failed to
-- clone (see bug report 6a04a0d5) — the clone succeeded but manage_durable_objects
-- action=list on the dest returned an empty array.

ALTER TABLE template_clone_jobs DROP CONSTRAINT IF EXISTS template_clone_jobs_status_check;
ALTER TABLE template_clone_jobs ADD CONSTRAINT template_clone_jobs_status_check
  CHECK (status IN (
    'pending', 'processing',
    'replaying_schema', 'replaying_rls',
    'replaying_durable_objects',
    'replaying_functions', 'replaying_config',
    'copying_repo', 'seeding_data',
    'completed', 'failed'
  ));
