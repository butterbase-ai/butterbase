-- @scope: platform
-- Phase 4: per-user app projection so the dashboard "list my apps" view
-- doesn't have to fan out to every regional runtime DB. Authoritative
-- app data lives in the regional runtime DB; this is a cache.

CREATE TABLE user_app_index (
  app_id      TEXT          PRIMARY KEY,
  user_id     UUID          NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  region      TEXT          NOT NULL,
  subdomain   TEXT,
  app_name    TEXT,
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX user_app_index_by_user_idx
  ON user_app_index (user_id, created_at DESC);

CREATE INDEX user_app_index_by_region_idx
  ON user_app_index (region);

COMMENT ON TABLE user_app_index IS
  'Phase 4: dashboard "list my apps" projection. Authoritative app row lives in the regional runtime DB. Eventually consistent.';
