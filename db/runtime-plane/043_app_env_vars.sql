-- 043_app_env_vars.sql
-- Per-app encrypted environment variables. Merged into ctx.env at function load
-- time, overridden by per-function encrypted_env_vars, then by platform BUTTERBASE_*.

CREATE TABLE IF NOT EXISTS app_env_vars (
  app_id             text PRIMARY KEY,
  encrypted_env_vars text NOT NULL,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         text
);
