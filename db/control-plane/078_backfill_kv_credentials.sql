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

-- The apps table moved to runtime-plane in the Phase 1 cutover, so the FK
-- from app_kv_credentials.app_id → apps(id) (control-plane) references a
-- table that no longer exists in this DB. Drop it before backfilling, or
-- the INSERT below fails on every row whose app_id has no control-plane
-- apps peer (i.e. all of them, post-cutover).
ALTER TABLE app_kv_credentials
  DROP CONSTRAINT IF EXISTS app_kv_credentials_app_id_fkey;

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
