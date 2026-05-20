-- @scope: platform
-- Add subdomain column for *.butterbase.dev routing
ALTER TABLE apps ADD COLUMN IF NOT EXISTS subdomain TEXT;

-- Globally unique index (only one app per subdomain)
CREATE UNIQUE INDEX IF NOT EXISTS idx_apps_subdomain
  ON apps(subdomain) WHERE subdomain IS NOT NULL;

-- Backfill: set subdomain = name for existing apps (names are already lowercase alphanumeric)
UPDATE apps SET subdomain = REPLACE(name, '_', '-')
  WHERE subdomain IS NULL;
