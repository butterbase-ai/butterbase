-- @scope: platform
-- 040: Custom domains for frontend deployments (Cloudflare for SaaS)
CREATE TABLE IF NOT EXISTS app_custom_domains (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id                TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  hostname              TEXT NOT NULL,
  cf_custom_hostname_id TEXT,
  status                TEXT NOT NULL DEFAULT 'pending',
  ssl_status            TEXT NOT NULL DEFAULT 'pending',
  verification_type     TEXT,
  verification_value    TEXT,
  verification_errors   JSONB,
  domain_type           TEXT NOT NULL DEFAULT 'frontend',
  is_primary            BOOLEAN NOT NULL DEFAULT false,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Each hostname globally unique across all apps
CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_domains_hostname
  ON app_custom_domains(hostname);

-- Fast lookup by app
CREATE INDEX IF NOT EXISTS idx_custom_domains_app_id
  ON app_custom_domains(app_id);

-- Fast lookup by Cloudflare custom hostname ID (for status updates)
CREATE INDEX IF NOT EXISTS idx_custom_domains_cf_id
  ON app_custom_domains(cf_custom_hostname_id)
  WHERE cf_custom_hostname_id IS NOT NULL;
