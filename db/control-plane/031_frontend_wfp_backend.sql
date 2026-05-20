-- @scope: platform
-- 031_frontend_wfp_backend.sql
-- Add per-app selector for frontend deployment backend (Cloudflare Pages vs Workers for Platforms).
-- Existing apps keep 'pages'; new rows are given the default-per-env by application logic.

ALTER TABLE apps
  ADD COLUMN deployment_backend TEXT NOT NULL DEFAULT 'pages'
  CONSTRAINT apps_deployment_backend_check CHECK (deployment_backend IN ('pages', 'wfp'));

CREATE INDEX idx_apps_deployment_backend_wfp ON apps(id) WHERE deployment_backend = 'wfp';

-- env_vars_stale flag for WfP: set when customer updates env vars without redeploying.
-- WfP env bindings are baked into the script, so a redeploy is required to apply them.
ALTER TABLE app_deployments
  ADD COLUMN env_vars_stale BOOLEAN NOT NULL DEFAULT false;
