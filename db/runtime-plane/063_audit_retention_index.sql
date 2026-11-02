-- @scope: runtime
-- Give shared audit retention an ordered path independent of app_id.
-- On populated databases, prebuild this exact index CONCURRENTLY using a
-- direct connection, verify validity/definition, then journal this migration.
CREATE INDEX IF NOT EXISTS idx_audit_events_created_id
  ON public.audit_events (created_at, id);
