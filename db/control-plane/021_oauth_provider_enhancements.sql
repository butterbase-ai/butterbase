-- @scope: platform
-- 021_oauth_provider_enhancements.sql
-- Add PKCE support to oauth_states and provider metadata to oauth configs

-- Store PKCE code_verifier alongside state tokens (for X/Twitter, custom providers)
ALTER TABLE oauth_states
ADD COLUMN IF NOT EXISTS code_verifier TEXT;

-- Store provider-specific metadata (e.g., Apple's teamId/keyId/privateKey)
ALTER TABLE app_oauth_configs
ADD COLUMN IF NOT EXISTS provider_metadata JSONB DEFAULT '{}';
