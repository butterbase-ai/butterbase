-- 072_app_kv_credentials.sql
-- Per-app credentials for the user-facing KV primitive.
-- One row per app. Created at app-creation time. Password rotated via control-api.

CREATE TABLE app_kv_credentials (
    app_id           TEXT PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
    region           TEXT NOT NULL,
    redis_password   TEXT NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    rotated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX app_kv_credentials_region_idx ON app_kv_credentials(region);

COMMENT ON TABLE app_kv_credentials IS
    'Per-app credentials for the KV primitive. Region matches the app''s data-plane region.';
COMMENT ON COLUMN app_kv_credentials.redis_password IS
    'Per-app password. Used by the kv-gateway worker on Redis AUTH. Plaintext at rest in control-plane DB — control-plane DB is access-restricted.';
