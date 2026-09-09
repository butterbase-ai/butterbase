-- @scope: platform
-- At most one in-flight reset per staging app.
--
-- Unlike promote-vs-reset (idx_template_clone_jobs_one_promote, migration
-- 116, cannot guard reset-vs-promote because a promote's dest_app_id is
-- PRODUCTION while a reset's dest_app_id is STAGING — two different columns
-- of the same table), reset-vs-reset IS expressible this way: every
-- staging_reset job's dest_app_id is the staging app, so two concurrent
-- resets against the same staging app collide on the same column value.
-- Matches idx_template_clone_jobs_one_promote's predicate shape exactly:
-- `status NOT IN ('completed','failed')`, which agrees with
-- TERMINAL_CLONE_STATUSES in clone-jobs.ts and with the predicate
-- getActiveResetJob (staging-reset.ts) queries with, so the index and the
-- query agree on what "in-flight" means.
CREATE UNIQUE INDEX IF NOT EXISTS idx_template_clone_jobs_one_reset
  ON template_clone_jobs (dest_app_id)
  WHERE mode = 'staging_reset' AND status NOT IN ('completed', 'failed');
