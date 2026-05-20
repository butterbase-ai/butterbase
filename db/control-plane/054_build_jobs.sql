-- @scope: platform
-- 054_build_jobs.sql
-- One row per server-side build invocation. deployment_id points at either
-- app_edge_ssr_deployments.id or app_deployments.id depending on deploy_type;
-- intentionally not a hard FK because the target table is type-dependent.

CREATE TABLE IF NOT EXISTS app_build_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deployment_id UUID NOT NULL,
  deploy_type TEXT NOT NULL CHECK (deploy_type IN ('edge_ssr', 'frontend')),
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'BUILDING', 'DEPLOYING', 'READY', 'FAILED')),
  build_command TEXT,
  output_dir TEXT,
  package_manager TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  exit_code INTEGER,
  failure_reason TEXT,
  log_r2_key TEXT,
  artifact_r2_key TEXT,
  source_r2_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS app_build_jobs_deployment_id_idx
  ON app_build_jobs(deployment_id);

CREATE INDEX IF NOT EXISTS app_build_jobs_status_created_at_idx
  ON app_build_jobs(status, created_at DESC);
