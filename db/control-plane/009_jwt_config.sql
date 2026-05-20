-- @scope: platform
-- Add JWT configuration to apps table
ALTER TABLE apps ADD COLUMN IF NOT EXISTS jwt_config JSONB DEFAULT '{"accessTokenTtl": "15m", "refreshTokenTtlDays": 7}'::jsonb;

-- Add index for faster lookups
CREATE INDEX IF NOT EXISTS idx_apps_jwt_config ON apps USING gin (jwt_config);

-- Add comment
COMMENT ON COLUMN apps.jwt_config IS 'JWT token configuration: accessTokenTtl (e.g., "15m", "1h", "2h"), refreshTokenTtlDays (integer)';
