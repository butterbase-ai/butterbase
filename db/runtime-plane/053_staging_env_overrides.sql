-- @scope: runtime
-- Per-staging-app env var overrides, supplied by the app owner. Layered over
-- the values inherited from production at every replay, so a staging app can
-- point at a sandbox payment key while production keeps the live one.
--
-- Encrypted with AUTH_ENCRYPTION_KEY, same as app_env_vars.encrypted_env_vars.
CREATE TABLE IF NOT EXISTS staging_env_overrides (
  staging_app_id        TEXT PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  encrypted_overrides   TEXT NOT NULL,
  updated_by            UUID NOT NULL,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
