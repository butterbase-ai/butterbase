-- @scope: platform
-- Stores per-app Neon connection strings (production only).
-- In local dev, app-pool.ts uses the local data-plane Postgres directly.
CREATE TABLE IF NOT EXISTS app_db_connections (
  app_id TEXT PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  connection_string TEXT NOT NULL,
  pooler_connection_string TEXT,
  neon_project_id TEXT,
  neon_database_name TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
