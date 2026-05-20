-- @scope: data
-- Tracks which data-plane template migrations have been applied to this app database.
-- Mirrors the control-plane _migrations table pattern.
CREATE TABLE IF NOT EXISTS _data_plane_migrations (
  id SERIAL PRIMARY KEY,
  filename TEXT NOT NULL UNIQUE,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
