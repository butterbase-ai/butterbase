-- @scope: platform
-- Update-mode jobs ride on template_clone_jobs so they inherit the existing
-- reaper, pruner, retry counting and in-flight snapshot pinning. `mode`
-- discriminates; consumers that must not see update rows filter on it.

ALTER TABLE template_clone_jobs
  ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'clone';

ALTER TABLE template_clone_jobs
  ADD COLUMN IF NOT EXISTS target_release_id TEXT NULL REFERENCES template_releases(id);

ALTER TABLE template_clone_jobs
  ADD COLUMN IF NOT EXISTS pre_sync_snapshot_id TEXT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'template_clone_jobs_mode_check'
  ) THEN
    ALTER TABLE template_clone_jobs
      ADD CONSTRAINT template_clone_jobs_mode_check CHECK (mode IN ('clone','update'));
  END IF;
END $$;

-- At most one in-flight update per fork.
CREATE UNIQUE INDEX IF NOT EXISTS idx_template_clone_jobs_one_update
  ON template_clone_jobs (dest_app_id)
  WHERE mode = 'update' AND status IN ('pending', 'processing');

COMMENT ON COLUMN template_clone_jobs.mode IS
  'clone = provision a new app; update = reset an existing fork in place.';
COMMENT ON COLUMN template_clone_jobs.pre_sync_snapshot_id IS
  'Fork repo HEAD before an update ran. Undo target. Code only — schema is forward-only.';
