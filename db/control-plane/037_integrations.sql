-- @scope: platform
-- 037_integrations.sql
-- Composio integrations tables

-- Stores the Composio auth config IDs per-app per-toolkit.
-- No separate "composio project" — we use one platform API key
-- and namespace users as {app_id}_{user_id}.
CREATE TABLE IF NOT EXISTS app_integration_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  toolkit_slug TEXT NOT NULL,
  composio_auth_config_id TEXT NOT NULL,
  display_name TEXT,
  enabled BOOLEAN NOT NULL DEFAULT true,
  scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(app_id, toolkit_slug)
);

CREATE INDEX IF NOT EXISTS idx_integration_configs_app
  ON app_integration_configs (app_id);

-- Tracks which end-users have connected which integrations.
CREATE TABLE IF NOT EXISTS app_connected_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  app_user_id UUID NOT NULL,
  toolkit_slug TEXT NOT NULL,
  composio_account_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive', 'expired')),
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  UNIQUE(app_id, app_user_id, toolkit_slug)
);

CREATE INDEX IF NOT EXISTS idx_connected_accounts_app
  ON app_connected_accounts (app_id);
CREATE INDEX IF NOT EXISTS idx_connected_accounts_user
  ON app_connected_accounts (app_id, app_user_id);
