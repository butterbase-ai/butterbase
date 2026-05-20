-- @scope: platform
-- Migration 022: Realtime Configuration Tracking
--
-- Tracks which app tables have realtime enabled, so the MCP tools
-- and dashboard can query the current configuration.

CREATE TABLE IF NOT EXISTS app_realtime_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  table_name TEXT NOT NULL,
  events TEXT[] DEFAULT ARRAY['INSERT','UPDATE','DELETE'],
  enabled BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(app_id, table_name)
);

CREATE INDEX IF NOT EXISTS idx_app_realtime_config_app
  ON app_realtime_config(app_id) WHERE enabled = TRUE;
