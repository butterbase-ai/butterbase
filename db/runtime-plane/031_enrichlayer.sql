-- 031_enrichlayer.sql — EnrichLayer managed-integration tables.

CREATE TABLE IF NOT EXISTS enrichlayer_usage_logs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id          text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL,
  action          text NOT NULL,
  credits_consumed integer NOT NULL DEFAULT 0,
  usd_cost        numeric(10, 6) NOT NULL DEFAULT 0,
  usd_charged     numeric(10, 6) NOT NULL DEFAULT 0,
  key_type        text NOT NULL CHECK (key_type IN ('platform', 'byok')),
  request_id      text,
  response_status integer,
  linkedin_url    text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_el_usage_app_created ON enrichlayer_usage_logs (app_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_el_usage_user_created ON enrichlayer_usage_logs (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS enrichlayer_profile_cache (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id         text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  normalized_url text NOT NULL,
  status         text NOT NULL CHECK (status IN ('ok','not_found','failed')),
  payload_jsonb  jsonb,
  fetched_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  UNIQUE (app_id, normalized_url)
);
CREATE INDEX IF NOT EXISTS idx_el_cache_expires ON enrichlayer_profile_cache (expires_at);

CREATE TABLE IF NOT EXISTS enrichlayer_email_lookups (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id          text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL,
  normalized_url  text NOT NULL,
  nonce           text NOT NULL UNIQUE,
  status          text NOT NULL CHECK (status IN ('pending','resolved','expired','failed')),
  email           text,
  credits_consumed integer NOT NULL DEFAULT 0,
  requested_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz
);
CREATE INDEX IF NOT EXISTS idx_el_email_pending ON enrichlayer_email_lookups (status, requested_at) WHERE status = 'pending';

ALTER TABLE apps
  ADD COLUMN IF NOT EXISTS enrichlayer_byok_key_encrypted bytea;
