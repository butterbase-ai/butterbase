-- @scope: platform
-- Migration 034: Audit Events (broadened audit log)
-- Replaces the auth-only auth_audit_logs table with a richer schema that
-- captures authentication, administrative, and function-invocation events.
-- The legacy table stays in place for historical reads; all new writes
-- go to audit_events.

CREATE TABLE audit_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app_id TEXT NOT NULL,
    category TEXT NOT NULL,           -- 'auth' | 'admin' | 'function'
    event_type TEXT NOT NULL,         -- e.g. 'login', 'schema.apply', 'function.invoke'
    action TEXT,                      -- 'create' | 'update' | 'delete' | 'invoke' | 'enable' | 'disable' | NULL
    resource_type TEXT,               -- 'schema' | 'rls_policy' | 'function' | 'oauth_provider' | ...
    resource_id TEXT,                 -- function name, policy name, deployment id, object id, etc.
    actor_type TEXT NOT NULL,         -- 'platform_user' | 'app_user' | 'api_key' | 'system' | 'anonymous'
    actor_id TEXT,                    -- platform user id, app user id, api key id
    event_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    ip_address INET,
    user_agent TEXT,
    success BOOLEAN NOT NULL,
    error_message TEXT,
    correlation_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_events_app_created ON audit_events(app_id, created_at DESC);
CREATE INDEX idx_audit_events_app_category ON audit_events(app_id, category, created_at DESC);
CREATE INDEX idx_audit_events_app_resource ON audit_events(app_id, resource_type, resource_id, created_at DESC);
CREATE INDEX idx_audit_events_actor ON audit_events(actor_type, actor_id, created_at DESC);
CREATE INDEX idx_audit_events_event_type ON audit_events(app_id, event_type, created_at DESC);

COMMENT ON TABLE audit_events IS 'Unified audit trail: auth events, admin mutations, function invocations';
