-- @scope: data
CREATE TABLE IF NOT EXISTS _ai_migrations (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    applied_by TEXT NOT NULL DEFAULT 'system',
    sql_up TEXT NOT NULL,
    sql_down TEXT,
    checksum TEXT,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
