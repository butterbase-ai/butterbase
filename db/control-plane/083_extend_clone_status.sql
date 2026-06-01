-- @scope: platform
-- Extend template_clone_jobs.status with intermediate replay steps
-- and add a warnings JSONB column for soft-failure recording.

ALTER TABLE template_clone_jobs DROP CONSTRAINT IF EXISTS template_clone_jobs_status_check;
ALTER TABLE template_clone_jobs ADD CONSTRAINT template_clone_jobs_status_check
  CHECK (status IN (
    'pending', 'processing',
    'replaying_schema', 'replaying_rls', 'replaying_functions', 'replaying_config',
    'copying_repo', 'seeding_data',
    'completed', 'failed'
  ));

ALTER TABLE template_clone_jobs ADD COLUMN IF NOT EXISTS warnings JSONB;
