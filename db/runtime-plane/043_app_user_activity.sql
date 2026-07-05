-- @scope: runtime
-- Powers the admin dashboard's "is this app's end-users active?" view.
-- Adds last_activity_at to app_users for per-user recency, and introduces
-- app_user_activity_daily for per-app daily rollup counts.

ALTER TABLE app_users ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS app_user_activity_daily (
  app_id        TEXT    NOT NULL,
  app_user_id   UUID    NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  day           DATE    NOT NULL,
  action_count  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (app_user_id, day)
);

CREATE INDEX IF NOT EXISTS idx_app_user_activity_app_day
  ON app_user_activity_daily(app_id, day DESC);

CREATE INDEX IF NOT EXISTS idx_app_users_app_last_activity
  ON app_users(app_id, last_activity_at DESC NULLS LAST);
