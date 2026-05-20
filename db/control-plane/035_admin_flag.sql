-- @scope: platform
ALTER TABLE platform_users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false;
