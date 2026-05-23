-- 073_app_kv_function_key.sql
-- Adds a per-app KV "function key" — an API key minted at provisioning time
-- that the deno-runtime injects into a function's env as
-- BUTTERBASE_FUNCTION_SERVICE_KEY, so ctx.kv.* can authenticate to kv-gateway
-- without the developer manually providing a key.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE app_kv_credentials
  ADD COLUMN kv_function_key TEXT;

-- Backfill: existing rows (if any) get a freshly generated key.
UPDATE app_kv_credentials
SET kv_function_key = encode(gen_random_bytes(24), 'hex')
WHERE kv_function_key IS NULL;

ALTER TABLE app_kv_credentials
  ALTER COLUMN kv_function_key SET NOT NULL;

COMMENT ON COLUMN app_kv_credentials.kv_function_key IS
  'Per-app API key for ctx.kv. Auto-injected as BUTTERBASE_FUNCTION_SERVICE_KEY into the function runtime. NOT a user-visible API key — distinct from rows in api_keys.';
