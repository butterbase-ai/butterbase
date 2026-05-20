-- @scope: platform
-- 070: Add digest_enabled opt-in column to notification_preferences.
--
-- Backs Phase 4 of the notification overhaul. Default false — users opt in
-- explicitly. The digest scanner reads this column to decide who to email.
-- No suppression of per-failure tier emails: digest is additive, not a
-- replacement, so users who want quiet can independently unsubscribe from
-- the function_failed template.

BEGIN;

ALTER TABLE notification_preferences
  ADD COLUMN IF NOT EXISTS digest_enabled boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS notification_preferences_digest_idx
  ON notification_preferences (user_id) WHERE digest_enabled = true;

COMMIT;
