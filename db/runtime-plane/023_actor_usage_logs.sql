-- @scope: runtime
-- Time-dimensioned usage for actor-style providers.

CREATE TYPE actor_usage_dimension AS ENUM ('recording', 'transcription');

CREATE TABLE actor_usage_logs (
  id            BIGSERIAL PRIMARY KEY,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  app_id        TEXT,
  user_id       TEXT,
  provider_key  TEXT NOT NULL,
  actor_id      TEXT NOT NULL,
  dimension     actor_usage_dimension NOT NULL,
  seconds       INTEGER NOT NULL CHECK (seconds >= 0),
  usd_cost      NUMERIC(12,6) NOT NULL,
  usd_charged   NUMERIC(12,6) NOT NULL,
  markup_pct    NUMERIC(6,3) NOT NULL,
  lease_id      TEXT,
  request_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT actor_usage_logs_actor_id_dimension_key UNIQUE (actor_id, dimension)
);

CREATE INDEX idx_actor_usage_logs_app_id_created_at
  ON actor_usage_logs (app_id, created_at DESC);
CREATE INDEX idx_actor_usage_logs_user_id_created_at
  ON actor_usage_logs (user_id, created_at DESC);
