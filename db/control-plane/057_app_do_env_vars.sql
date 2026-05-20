-- @scope: platform
-- Per-app environment variables for Durable Object scripts.
--
-- DOs need a way to receive app-specific config (e.g. APP_ID for token
-- verification, upstream API base URLs, secrets for external calls). Without
-- this table, users were hardcoding values into the DO source — tedious and
-- a leak risk for anything sensitive.
--
-- Mirrors app_frontend_env_vars: encrypted_value uses the same AUTH_ENCRYPTION_KEY
-- envelope. Vars are bundled into the DO Worker as plain_text bindings on every
-- bundleAndDeploy, so changing a value requires a DO redeploy to take effect.
-- The env-set route triggers that redeploy automatically when at least one
-- active DO class exists for the app.

CREATE TABLE IF NOT EXISTS app_do_env_vars (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    key VARCHAR(100) NOT NULL,
    encrypted_value TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (app_id, key)
);

CREATE INDEX IF NOT EXISTS idx_app_do_env_vars_app ON app_do_env_vars(app_id);
