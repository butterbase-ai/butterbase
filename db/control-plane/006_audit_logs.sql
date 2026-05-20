-- @scope: platform
-- Migration 006: Audit Logs and OAuth State
-- Adds audit logging for security events and persistent OAuth state storage

-- Audit log for security events
CREATE TABLE auth_audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app_id TEXT NOT NULL,
    user_id UUID REFERENCES app_users(id) ON DELETE SET NULL,
    event_type TEXT NOT NULL,
    event_data JSONB DEFAULT '{}',
    ip_address INET,
    user_agent TEXT,
    success BOOLEAN NOT NULL,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for common queries
CREATE INDEX idx_auth_audit_logs_app_id ON auth_audit_logs(app_id);
CREATE INDEX idx_auth_audit_logs_user_id ON auth_audit_logs(user_id);
CREATE INDEX idx_auth_audit_logs_event_type ON auth_audit_logs(event_type);
CREATE INDEX idx_auth_audit_logs_created_at ON auth_audit_logs(created_at DESC);
CREATE INDEX idx_auth_audit_logs_ip_address ON auth_audit_logs(ip_address);

-- Composite index for user activity queries
CREATE INDEX idx_auth_audit_logs_user_activity ON auth_audit_logs(user_id, created_at DESC);

COMMENT ON TABLE auth_audit_logs IS 'Audit trail for authentication and security events';

-- OAuth state tokens for CSRF protection
CREATE TABLE oauth_states (
    state TEXT PRIMARY KEY,
    app_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for cleanup queries
CREATE INDEX idx_oauth_states_expires_at ON oauth_states(expires_at);

COMMENT ON TABLE oauth_states IS 'Temporary storage for OAuth state tokens (CSRF protection)';
