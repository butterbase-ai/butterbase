-- @scope: runtime
-- 016_apps_template_source_region.sql
-- B2: Store the source app's region at clone time.
--
-- template_source_app_id (added in 014) is a soft cross-region reference.
-- The delete handler needs to know the source app's region so it can insert
-- a fork_count_decrements row with the correct target; without this column
-- we would have to fan-out a lookup across every region's runtime DB on every
-- delete, which is expensive and fragile.
--
-- Populated by the clone worker when it creates the destination app row.
-- NULL for apps created before this migration and for apps that are not clones.

ALTER TABLE apps ADD COLUMN template_source_region TEXT NULL;

COMMENT ON COLUMN apps.template_source_region IS
  'Region slug of the template source app this app was cloned from. NULL when not a clone.';
