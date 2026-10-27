-- @scope: runtime
-- F-04: add organization_id to audit_events (runtime-plane)
-- Backfills via app_id → apps.organization_id, then adds indexes mirroring
-- the app_id-keyed set defined in control-plane/034_audit_events.sql:27-31.

ALTER TABLE audit_events
  ADD COLUMN IF NOT EXISTS organization_id uuid;

UPDATE audit_events ae
   SET organization_id = a.organization_id
  FROM apps a
 WHERE ae.app_id = a.id
   AND ae.organization_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_audit_events_org_created
  ON audit_events (organization_id, created_at DESC)
  WHERE organization_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_audit_events_org_category
  ON audit_events (organization_id, category, created_at DESC)
  WHERE organization_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_audit_events_org_resource
  ON audit_events (organization_id, resource_type, resource_id, created_at DESC)
  WHERE organization_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_audit_events_org_event_type
  ON audit_events (organization_id, event_type, created_at DESC)
  WHERE organization_id IS NOT NULL;

COMMENT ON COLUMN audit_events.organization_id IS
  'Org that owns this event. Backfilled from apps.organization_id; nullable for rows with no matching app.';
