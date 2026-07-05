-- @scope: platform
-- Powers the admin dashboard's "is this platform user active?" view. last_login_at
-- and last_activity_at are the fast-path answers; platform_user_activity_daily
-- gives the 30-day sparkline.

ALTER TABLE platform_users
  ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS platform_user_activity_daily (
  user_id UUID NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  action_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);

CREATE INDEX IF NOT EXISTS idx_platform_users_last_activity
  ON platform_users (last_activity_at DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_platform_user_activity_day
  ON platform_user_activity_daily (day DESC);
