CREATE TABLE IF NOT EXISTS kv_app_usage_snapshot (
  app_id        TEXT PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  region        TEXT NOT NULL,
  bytes_used    BIGINT NOT NULL DEFAULT 0,
  keys_total    BIGINT NOT NULL DEFAULT 0,
  snapshot_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_kv_app_usage_snapshot_bytes ON kv_app_usage_snapshot (bytes_used DESC);
CREATE INDEX IF NOT EXISTS idx_kv_app_usage_snapshot_keys  ON kv_app_usage_snapshot (keys_total DESC);
