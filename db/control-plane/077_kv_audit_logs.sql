-- @scope: platform
-- Migration 077: KV audit logs for HTTP request tracking
-- Records KV gateway request outcomes (method, path, status) for the dashboard "Recent errors" panel.

CREATE TABLE IF NOT EXISTS audit_logs (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    app_id      TEXT        NOT NULL,
    actor_id    TEXT,
    method      TEXT        NOT NULL,
    path        TEXT        NOT NULL,
    status_code INTEGER     NOT NULL,
    error_code  TEXT,
    error_message TEXT,
    at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_app_at     ON audit_logs (app_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_app_status ON audit_logs (app_id, status_code, at DESC);

COMMENT ON TABLE audit_logs IS 'KV gateway HTTP request audit log — used by dashboard Recent Errors panel';
