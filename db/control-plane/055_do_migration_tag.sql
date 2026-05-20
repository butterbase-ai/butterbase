-- @scope: platform
-- 055_do_migration_tag.sql
-- Add migration_tag to app_do_deploy_state so we can pass `old_tag` on
-- subsequent CF DO Worker deploys. Cloudflare requires the old_tag to match
-- the script's current tag whenever migrations are present, otherwise the
-- request is rejected with code 10079 ("Actor migration tag precondition
-- failed"). Apps deployed before this migration will have NULL here; the
-- service backfills by reading the current tag from CF on the next deploy.

ALTER TABLE app_do_deploy_state
  ADD COLUMN IF NOT EXISTS migration_tag TEXT;
