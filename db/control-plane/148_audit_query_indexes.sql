-- @scope: platform
-- Match actor-only history and global time-ordered history/retention reads.
-- On populated databases, prebuild these exact indexes CONCURRENTLY using a
-- direct connection, verify validity/definitions, then journal this migration.
CREATE INDEX IF NOT EXISTS idx_audit_events_actor_created
  ON public.audit_events (actor_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_created_id
  ON public.audit_events (created_at, id);
