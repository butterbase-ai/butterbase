-- @scope: runtime
-- 056: Idle free-app pause (docs/superpowers/specs/2026-10-10-idle-free-app-pause-design.md §4).
--
-- last_active_at: stamped by control-api on real traffic and owner actions
--   (never by cron). The column DEFAULT both backfills every existing row to
--   the migration time — so every app starts with a full idle window and
--   nothing can be idle-paused until N days after this ships — and stamps new
--   inserts (provisioner, move-app) without code changes.
-- idle_warned_at: set when the idle-warning email goes out; any activity or a
--   resume clears it.
-- paused_by: who set apps.paused. NULL whenever the app is not paused.
--
-- Additive and nullable: the previous control-api image ignores all three.
ALTER TABLE apps ADD COLUMN IF NOT EXISTS last_active_at timestamptz DEFAULT now();
ALTER TABLE apps ADD COLUMN IF NOT EXISTS idle_warned_at timestamptz;
ALTER TABLE apps ADD COLUMN IF NOT EXISTS paused_by text;

-- Label pauses that already exist. The staging reaper's text is fixed in
-- services/control-api/src/services/staging-reaper.ts (runOnce).
UPDATE apps SET paused_by = 'staging_reaper'
 WHERE paused
   AND paused_by IS NULL
   AND id IN (SELECT staging_app_id FROM app_environments)
   AND paused_reason LIKE 'Automatically paused after % days of inactivity.';
UPDATE apps SET paused_by = 'owner' WHERE paused AND paused_by IS NULL;

ALTER TABLE apps DROP CONSTRAINT IF EXISTS apps_paused_by_check;
ALTER TABLE apps ADD CONSTRAINT apps_paused_by_check
  CHECK (paused_by IS NULL OR paused_by IN ('owner', 'admin', 'idle_reaper', 'staging_reaper'));
