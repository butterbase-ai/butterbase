-- @scope: platform
-- Migration 004: Auth Service Tables
-- Adds end-user authentication infrastructure

-- Extend app_users table with new auth fields
ALTER TABLE app_users
ADD COLUMN email_verified BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN display_name TEXT,
ADD COLUMN avatar_url TEXT,
ADD COLUMN last_sign_in_at TIMESTAMPTZ;

-- Add unique index for OAuth provider users
CREATE UNIQUE INDEX idx_app_users_provider_uid
ON app_users(app_id, provider, provider_uid)
WHERE provider_uid IS NOT NULL;

-- App signing keys (RSA key pairs for JWT signing)
CREATE TABLE app_signing_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    kid TEXT NOT NULL,
    algorithm TEXT NOT NULL DEFAULT 'RS256',
    private_key_encrypted TEXT NOT NULL,
    public_key TEXT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(app_id, kid)
);
CREATE INDEX idx_app_signing_keys_app_id ON app_signing_keys(app_id);

-- OAuth provider configurations per app
CREATE TABLE app_oauth_configs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    client_id TEXT,
    client_secret_encrypted TEXT,
    scopes TEXT[],
    authorization_url TEXT,
    token_url TEXT,
    userinfo_url TEXT,
    enabled BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(app_id, provider)
);
CREATE INDEX idx_app_oauth_configs_app_id ON app_oauth_configs(app_id);

-- Refresh tokens for end-user sessions
CREATE TABLE app_refresh_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app_id TEXT NOT NULL,
    user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_app_refresh_tokens_token_hash ON app_refresh_tokens(token_hash);
CREATE INDEX idx_app_refresh_tokens_user ON app_refresh_tokens(app_id, user_id);

-- Verification codes for email verification and password reset
CREATE TABLE app_verification_codes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app_id TEXT NOT NULL,
    user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_app_verification_codes_user ON app_verification_codes(app_id, user_id);
CREATE INDEX idx_app_verification_codes_expires ON app_verification_codes(expires_at);
