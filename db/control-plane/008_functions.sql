-- @scope: platform
-- Serverless functions for apps
CREATE TABLE app_functions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    code TEXT NOT NULL,
    encrypted_env_vars TEXT,
    timeout_ms INT NOT NULL DEFAULT 30000,
    memory_limit_mb INT NOT NULL DEFAULT 128,
    trigger_type VARCHAR(20) NOT NULL DEFAULT 'http',
    trigger_config JSONB DEFAULT '{}',
    deployed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deployed_by UUID REFERENCES platform_users(id),
    last_invoked_at TIMESTAMPTZ,
    invocation_count BIGINT NOT NULL DEFAULT 0,
    error_count BIGINT NOT NULL DEFAULT 0,
    avg_duration_ms NUMERIC(10, 2),
    deleted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(app_id, name)
);

CREATE INDEX idx_app_functions_app_id ON app_functions(app_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_app_functions_trigger_type ON app_functions(trigger_type) WHERE deleted_at IS NULL;

-- Function invocation logs for debugging and billing
CREATE TABLE function_invocations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    function_id UUID NOT NULL REFERENCES app_functions(id) ON DELETE CASCADE,
    app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    user_id UUID,
    method VARCHAR(10),
    path TEXT,
    headers JSONB,
    request_body_size_bytes INT,
    status_code INT,
    response_body_size_bytes INT,
    duration_ms INT,
    memory_used_mb NUMERIC(10, 2),
    error_message TEXT,
    error_stack TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,
    billed_duration_ms INT,
    billed_memory_mb INT
);

CREATE INDEX idx_function_invocations_function ON function_invocations(function_id, started_at DESC);
CREATE INDEX idx_function_invocations_app ON function_invocations(app_id, started_at DESC);
CREATE INDEX idx_function_invocations_billing ON function_invocations(app_id, started_at)
    WHERE completed_at IS NOT NULL;
