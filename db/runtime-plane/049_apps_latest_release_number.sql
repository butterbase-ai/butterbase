-- @scope: runtime
-- Denormalized pointer so template discovery can show a release count without a
-- control-plane join per list row. Written by publishRelease; control-plane
-- template_releases remains the source of truth.
ALTER TABLE apps ADD COLUMN IF NOT EXISTS latest_release_number INT NULL;

COMMENT ON COLUMN apps.latest_release_number IS
  'Highest release_number published for this app. NULL = never published.';
