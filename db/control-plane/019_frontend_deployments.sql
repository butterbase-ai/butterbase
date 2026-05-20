-- @scope: platform
-- Frontend deployment tracking
CREATE TABLE app_deployments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    framework VARCHAR(50),                    -- 'react-vite', 'nextjs', 'static', etc.
    deployment_url TEXT,                      -- Live URL after deployment
    cloudflare_project_name TEXT,             -- Cloudflare Pages project name
    cloudflare_deployment_id TEXT,            -- Cloudflare deployment ID
    status TEXT NOT NULL DEFAULT 'pending',   -- pending, uploading, deployed, failed
    error_message TEXT,
    build_config JSONB DEFAULT '{}',          -- { outputDir, envVars (names only, not values) }
    file_count INT,
    total_size_bytes BIGINT,
    deployed_by UUID REFERENCES platform_users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_app_deployments_app_id ON app_deployments(app_id);
CREATE INDEX idx_app_deployments_status ON app_deployments(status);

-- Add deployment columns to apps table
ALTER TABLE apps ADD COLUMN IF NOT EXISTS deployment_url TEXT;
ALTER TABLE apps ADD COLUMN IF NOT EXISTS last_deployed_at TIMESTAMPTZ;

-- Frontend environment variables (separate from function env vars)
CREATE TABLE app_frontend_env_vars (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    key VARCHAR(100) NOT NULL,
    encrypted_value TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (app_id, key)
);

CREATE INDEX idx_app_frontend_env_vars_app ON app_frontend_env_vars(app_id);
