-- @scope: runtime
-- 014_app_visibility.sql
-- Phase 1 of app-templates feature.
-- Adds template-visibility model + repo state hook + denormalized fork_count.
--
-- visibility:               'private' (default) | 'public'. Orthogonal to access_mode
--                           which controls anonymous *data API* access. visibility
--                           controls whether the app's *template metadata* is
--                           discoverable / clonable by others.
-- listed:                   When visibility='public', controls inclusion in the
--                           public browse listing at GET /v1/templates. public+unlisted
--                           is clonable by direct ID but hidden from the browse page.
-- template_source_app_id:   Lineage. May reference an app in a different region —
--                           the constraint is therefore a soft index, not an FK.
-- repo_latest_snapshot:     Phase 2 will populate. Phase 1 just reserves the column.
-- fork_count:               Denormalized count of clones whose source is this app.
--                           Same caveat as template_source_app_id: cross-region writes
--                           cannot fire a local trigger, so the clone worker is
--                           responsible for incrementing. The trigger here handles
--                           only the intra-region delete case (decrement on clone delete).

ALTER TABLE apps ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'
  CHECK (visibility IN ('private', 'public'));

ALTER TABLE apps ADD COLUMN listed BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE apps ADD COLUMN template_source_app_id TEXT NULL;
CREATE INDEX idx_apps_template_source ON apps(template_source_app_id)
  WHERE template_source_app_id IS NOT NULL;

ALTER TABLE apps ADD COLUMN repo_latest_snapshot TEXT NULL;

ALTER TABLE apps ADD COLUMN fork_count INTEGER NOT NULL DEFAULT 0
  CHECK (fork_count >= 0);

-- Trigger: decrement fork_count on intra-region clone delete.
-- Cross-region delete decrement is handled by the clone worker's outbox sweeper
-- (Phase 4); this trigger only fires when the source app happens to share a
-- region with its clone.
CREATE OR REPLACE FUNCTION apps_fork_count_on_delete()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.template_source_app_id IS NOT NULL THEN
    UPDATE apps
       SET fork_count = GREATEST(fork_count - 1, 0)
     WHERE id = OLD.template_source_app_id;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_apps_fork_count_delete
  AFTER DELETE ON apps
  FOR EACH ROW
  EXECUTE FUNCTION apps_fork_count_on_delete();

COMMENT ON COLUMN apps.visibility IS
  'Template visibility: private | public. Independent of access_mode.';
COMMENT ON COLUMN apps.listed IS
  'When visibility=public, controls inclusion in /v1/templates listing.';
COMMENT ON COLUMN apps.template_source_app_id IS
  'Soft reference to the app this one was cloned from. May live in another region.';
COMMENT ON COLUMN apps.repo_latest_snapshot IS
  'Phase 2 codebase-repo snapshot pointer. NULL when no repo has been pushed.';
COMMENT ON COLUMN apps.fork_count IS
  'Denormalized count of clones. Eventually consistent across regions.';
