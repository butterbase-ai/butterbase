-- @scope: runtime
-- Persist BYO OAuth credentials for integrations so clone replay can
-- recreate `use_custom_auth` configs on the destination.
--
-- Background: app_integration_configs only stored an opaque
-- composio_auth_config_id — the underlying client_id/client_secret/extras
-- (e.g. twitter's generic_id) lived only on Composio's side, behind that
-- id. Clone replay therefore could not reconstruct the BYO config and
-- silently fell back to use_composio_managed_auth, which Composio rejects
-- for any non-curated toolkit. Result: BYO toolkits (twitter, linkedin,
-- reddit, etc.) silently disappeared from cloned apps.
--
-- credentials_encrypted: AES-256-GCM ciphertext (iv:ct:tag base64) of
--   JSON.stringify({ client_id, client_secret, ...toolkit-specific extras })
--   under AUTH_ENCRYPTION_KEY. Same format as
--   services/control-api/src/services/crypto.ts.
-- auth_scheme:           Composio auth scheme (e.g. 'OAUTH2', 'BEARER_TOKEN').
--                        Needed verbatim by replay's authConfigs.create call.
--
-- Both columns are nullable: existing rows and curated/managed-auth rows
-- leave them NULL and continue working via the managed-auth replay path.

ALTER TABLE public.app_integration_configs
  ADD COLUMN IF NOT EXISTS credentials_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS auth_scheme TEXT;
