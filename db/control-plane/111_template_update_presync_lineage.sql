-- @scope: platform
-- Undo needs to restore the fork's COMPLETE pre-update state, not just its repo
-- pointer.
--
-- 110 recorded only pre_sync_snapshot_id. But executeUpdate's step 9 advances
-- app_lineage.base_snapshot_id to the NEW snapshot, and computeDivergence is
-- exactly `apps.repo_latest_snapshot !== app_lineage.base_snapshot_id`. So an
-- undo that rolled the repo pointer back and left lineage alone made the fork
-- read repo: true -> decideEligibility 'modified' -> permanently ineligible for
-- any future update, and shown to its owner as "You have changed this app."
-- Undo was a one-way trap; this column is what closes it.
--
-- Holds the pre-update app_lineage row (base_release_id, base_fingerprint,
-- base_snapshot_id) plus the fork's pre-update captureAppState manifest, so
-- undo can restore lineage AND function bodies. Written by the worker in the
-- same guarded step that records pre_sync_snapshot_id, before any mutation.
ALTER TABLE template_clone_jobs
  ADD COLUMN IF NOT EXISTS pre_sync_lineage JSONB NULL;

COMMENT ON COLUMN template_clone_jobs.pre_sync_lineage IS
  'Fork state before an update ran: {base_release_id, base_fingerprint, base_snapshot_id, manifest}. Undo restore source.';

-- Widen the in-flight-update mutex.
--
-- The old predicate was status IN ('pending','processing'), but executeUpdate
-- moves the job to 'copying_repo' before any gate and before a long S3 copy. In
-- that window a second POST /update passed getActiveUpdateJob, passed
-- eligibility, and this index did not fire -- two workers on the same fork, and
-- the second one's pre_sync_snapshot_id captured the FIRST one's post-update
-- HEAD, making its undo a silent no-op.
--
-- 'completed' and 'failed' are the only terminal statuses (isTerminalCloneStatus
-- in clone-jobs.ts names exactly that set); every other status, including the
-- mid-flight ones, means a job is still in flight.
DROP INDEX IF EXISTS idx_template_clone_jobs_one_update;
CREATE UNIQUE INDEX IF NOT EXISTS idx_template_clone_jobs_one_update
  ON template_clone_jobs (dest_app_id)
  WHERE mode = 'update' AND status NOT IN ('completed', 'failed');
