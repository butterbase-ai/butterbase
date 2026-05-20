-- @scope: platform
-- 052_edge_ssr_deployments.sql
-- Create app_edge_ssr_deployments table for tracking Edge SSR (WfP-based) deployments.
-- These are conceptually distinct from static frontend deployments (app_deployments):
-- they upload a _worker.js bundle (or chunked directory) to R2, then dispatch through
-- Cloudflare Workers for Platforms rather than Cloudflare Pages.
--
-- Mirrors the current app_deployments column set (019 + 020 + 031 additions) but:
--   - Omits cloudflare_project_name / cloudflare_deployment_id (not applicable to WfP)
--   - Omits `build_config` (no equivalent concept for SSR; zip structure is self-describing)
--   - Adds worker_script_size_bytes / worker_script_module_count for quota/observability
--   - Restricts framework to Edge SSR values via CHECK constraint (not a TYPE)
--   - Includes env_vars_stale for the same reason as static WfP deploys (031)
--
-- Rollback:
--   DROP TABLE IF EXISTS app_edge_ssr_deployments;

CREATE TABLE IF NOT EXISTS app_edge_ssr_deployments (
    id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app_id                    TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,

    -- Framework that produced this Edge SSR bundle
    framework                 TEXT NOT NULL CHECK (framework IN ('nextjs-edge', 'remix-edge', 'other-edge')),

    -- Deployment lifecycle
    status                    TEXT NOT NULL DEFAULT 'WAITING'
                                  CHECK (status IN ('WAITING', 'UPLOADING', 'BUILDING', 'READY', 'ERROR', 'CANCELED', 'SUPERSEDED')),
    error_message             TEXT,

    -- R2 upload tracking (same pattern as app_deployments)
    r2_object_key             TEXT,
    upload_expires_at         TIMESTAMPTZ,

    -- Timing
    started_at                TIMESTAMPTZ,
    completed_at              TIMESTAMPTZ,

    -- Bundle metadata
    file_count                INTEGER,
    total_size_bytes          BIGINT,

    -- WfP-specific worker script metadata
    worker_script_size_bytes  BIGINT,
    worker_script_module_count INTEGER,

    -- The live URL once deployed
    deployment_url            TEXT,

    -- Whether env bindings are stale relative to current app env vars
    -- (baked into WfP script at deploy time, so mutations require redeploy)
    env_vars_stale            BOOLEAN NOT NULL DEFAULT false,

    -- Audit
    deployed_by               UUID REFERENCES platform_users(id),

    created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Efficient listing of recent deployments by app and status
CREATE INDEX IF NOT EXISTS idx_edge_ssr_deployments_app_status_created
    ON app_edge_ssr_deployments (app_id, status, created_at DESC);

-- Efficient listing of recent deployments by app only (no status filter)
CREATE INDEX IF NOT EXISTS idx_edge_ssr_deployments_app_created
    ON app_edge_ssr_deployments (app_id, created_at DESC);
