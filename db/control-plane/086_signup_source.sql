-- @scope: platform
-- Tag the source of each platform signup so we can derive activation rate by
-- signup cohort + source. Powers the WAPA North Star metric.

ALTER TABLE platform_users
  ADD COLUMN IF NOT EXISTS signup_source   TEXT,
  ADD COLUMN IF NOT EXISTS signup_referrer TEXT;

CREATE INDEX IF NOT EXISTS idx_platform_users_created_at
  ON platform_users (created_at);
