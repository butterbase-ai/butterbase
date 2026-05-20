-- @scope: platform
-- Migration 005: MVP Features
-- Adds OAuth redirect URI validation and CORS configuration

-- OAuth redirect URI validation
ALTER TABLE app_oauth_configs
ADD COLUMN redirect_uris TEXT[] DEFAULT '{}';

COMMENT ON COLUMN app_oauth_configs.redirect_uris IS 'Whitelist of allowed redirect URIs for OAuth';

-- CORS configuration per app
ALTER TABLE apps
ADD COLUMN allowed_origins TEXT[] DEFAULT '{"http://localhost:3000"}';

COMMENT ON COLUMN apps.allowed_origins IS 'Whitelist of allowed CORS origins';

-- Create index for faster CORS lookups
CREATE INDEX idx_apps_allowed_origins ON apps USING GIN(allowed_origins);
