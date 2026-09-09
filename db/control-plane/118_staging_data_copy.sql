-- @scope: platform
-- 118: staging environments carry a real copy of production's data.
--
-- Until now a staging_create/staging_reset job replayed schema, functions and
-- the `_seed`-flagged tables only, and then reported 'completed'. The dashboard
-- and the manage_staging MCP tool both told the user staging was "a full copy
-- of this app ... including any personal data". It was not.
--
-- The copy itself is executed by the app-copy engine (control-plane table
-- app_copy_jobs, migration 112, internal deployments only). The staging path
-- ENQUEUES a job there and waits for it; it never runs a second copy engine.
-- Two schema changes are needed for that wait to be representable:
--
--   'copying_data'    — a NON-terminal clone-job status. A staging job sits in
--                       it from the moment the copy is enqueued until the copy
--                       reaches a terminal status. Without it the only way to
--                       express "provisioned but not yet populated" would be
--                       'completed', which is the same class of untruth this
--                       work exists to remove.
--   data_copy_job_id  — the app_copy_jobs id this clone job is waiting on.
--                       Recorded explicitly rather than re-derived from
--                       (source_app_id, dest_app_id): a staging app is reset
--                       repeatedly, so that pair has many copy jobs over time
--                       and "the newest one" is a guess, not an identity.
--
-- NUMBER: the highest file in either stream is 117_promote_optional_snapshot.sql
-- (OSS) / 114_template_clone_intents_audit_index.sql (cloud). 118 is free in
-- both. Note the warning in 112: `isAlreadyApplied` matches on FILENAME, so a
-- number colliding across the two streams is silently skipped rather than
-- erroring. Re-verify before picking the next one.

ALTER TABLE template_clone_jobs DROP CONSTRAINT IF EXISTS template_clone_jobs_status_check;
ALTER TABLE template_clone_jobs ADD CONSTRAINT template_clone_jobs_status_check
  CHECK (status IN (
    'pending', 'processing',
    'replaying_schema', 'replaying_rls',
    'replaying_durable_objects',
    'replaying_functions', 'replaying_config',
    'copying_repo', 'seeding_data',
    'copying_data',
    'completed', 'failed'
  ));

ALTER TABLE template_clone_jobs ADD COLUMN IF NOT EXISTS data_copy_job_id TEXT;

COMMENT ON COLUMN template_clone_jobs.data_copy_job_id IS
  'app_copy_jobs.id this staging_create/staging_reset job is waiting on while '
  'status = ''copying_data''. NULL for every other mode, and for a staging job '
  'on a deployment with no app-copy engine (see 112).';
