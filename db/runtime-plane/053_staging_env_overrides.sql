-- @scope: runtime
-- Env var overrides for an app's staging environment, supplied by the app
-- owner. Layered over the values inherited from production whenever staging's
-- env vars are materialised, so staging can point at a sandbox payment key
-- while production keeps the live one.
--
-- KEYED ON THE PRODUCTION APP, not the staging app, and deliberately so —
-- matching `app_environments` (052), which is keyed the same way.
--
-- Keying on staging_app_id would FK the overrides to a row that does not exist
-- until staging is created, which makes the only possible workflow: create
-- staging (every inherited key seeded empty), discover the functions are
-- broken, then set overrides. It would also CASCADE the owner's sandbox keys
-- away on any unlink-and-recreate, so their functions would start failing with
-- missing keys for no visible reason. Keyed on the production app, an owner can
-- stage the sandbox values BEFORE the first create — so staging comes up
-- working — and they survive a re-create.
--
-- Encrypted with AUTH_ENCRYPTION_KEY, same as app_env_vars.encrypted_env_vars.
CREATE TABLE IF NOT EXISTS staging_env_overrides (
  prod_app_id           TEXT PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  encrypted_overrides   TEXT NOT NULL,
  updated_by            UUID NOT NULL,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE staging_env_overrides IS
  'One row per production app. The values its staging environment uses INSTEAD of the ones inherited from production. Keyed on the production app so overrides can be set before staging exists and survive a staging re-create.';
