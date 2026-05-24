-- @scope: platform
-- 078_backfill_kv_credentials.sql
-- Backfill app_kv_credentials for apps created before KV provisioning was
-- wired into provisioner.ts. Pre-launch apps were never given a row, so the
-- KV dashboard panel 401s for them (tryPlatformOwnerJwt INNER JOINs against
-- app_kv_credentials and finds no row -> returns null -> 401 invalid_jwt).
--
-- For every user_app_index row that lacks an app_kv_credentials peer, mint
-- a fresh redis_password and kv_function_key with the same RNG/encoding the
-- node provisioner uses (24 random bytes hex-encoded).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

INSERT INTO app_kv_credentials (app_id, region, redis_password, kv_function_key)
SELECT
  uai.app_id,
  uai.region,
  encode(gen_random_bytes(24), 'hex'),
  encode(gen_random_bytes(24), 'hex')
FROM user_app_index uai
LEFT JOIN app_kv_credentials akc ON akc.app_id = uai.app_id
WHERE akc.app_id IS NULL
ON CONFLICT (app_id) DO NOTHING;
