-- @scope: platform
-- Staging environments ride on template_clone_jobs for the same reason update
-- mode does (see 110): they inherit the reaper, pruner, retry counting and
-- in-flight snapshot pinning for free.
--
--   staging_create — provision a staging sibling for a production app
--   promote        — apply the staging app's state onto its production app
--   staging_reset  — re-seed an existing staging app from production
ALTER TABLE template_clone_jobs DROP CONSTRAINT IF EXISTS template_clone_jobs_mode_check;

ALTER TABLE template_clone_jobs
  ADD CONSTRAINT template_clone_jobs_mode_check
  CHECK (mode IN ('clone', 'update', 'staging_create', 'promote', 'staging_reset'));

-- At most one in-flight promote per destination app. Matches
-- idx_template_clone_jobs_one_update as recreated in 111 (not its original
-- 110 form): `status NOT IN ('completed','failed')`, which agrees with
-- TERMINAL_CLONE_STATUSES in clone-jobs.ts and with the predicate
-- getActivePromoteJob queries with, so the index and the query agree on what
-- "in-flight" means.
CREATE UNIQUE INDEX IF NOT EXISTS idx_template_clone_jobs_one_promote
  ON template_clone_jobs (dest_app_id)
  WHERE mode = 'promote' AND status NOT IN ('completed', 'failed');

COMMENT ON COLUMN template_clone_jobs.mode IS
  'clone | update | staging_create | promote | staging_reset. See 110 and 116.';
