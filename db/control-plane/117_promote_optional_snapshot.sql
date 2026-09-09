-- @scope: platform
-- Task 14 fix round 1 (staging environments): a promote job must be able to
-- record "the staging app has no repo snapshot yet" instead of being forced
-- to fabricate a placeholder value in source_snapshot_id.
--
-- Before this, startPromote (promote-jobs.ts) wrote a synthetic
-- `promote:<app>:<timestamp>` string into source_snapshot_id because the
-- column was NOT NULL and there was no real snapshot to hash at request
-- time. That placeholder broke listActiveCloneSnapshotIdsForApp's retention
-- pin (clone-jobs.ts / routes/repo.ts): a promote in flight against a
-- staging app pinned NOTHING, so a repo push on that same app mid-promote
-- could delete the very snapshot the 'repo' step was about to copy.
--
-- Fix: startPromote now reads the staging app's ACTUAL apps.repo_latest_snapshot
-- at request time and pins that for real. When staging has never had a repo
-- push, source_snapshot_id is recorded as NULL — a backend-only promote
-- (schema/RLS/functions/config, no frontend) is a legitimate thing to want,
-- so execute-promote.ts's 'repo' step skips with a job warning instead of
-- refusing the whole promote. Every other mode (clone, update) still always
-- carries a real, non-null snapshot id (start-clone.ts's NO_SNAPSHOT refusal,
-- template-releases.ts's NoRepoSnapshotError) — NULL is promote-only.
ALTER TABLE template_clone_jobs ALTER COLUMN source_snapshot_id DROP NOT NULL;

COMMENT ON COLUMN template_clone_jobs.source_snapshot_id IS
  'Pinned at job-create time (see 082). NULL only for mode=promote jobs whose staging app had no repo snapshot at request time; every other mode requires a real snapshot id.';
