-- @scope: platform
-- F-04: add organization_id to audit_events (control-plane)
-- Backfills via app_id → org_app_index.organization_id (apps table was dropped
-- in 061_post_cutover_drop_runtime_tables.sql), then adds indexes mirroring
-- the app_id-keyed set defined in 034_audit_events.sql:27-31.

ALTER TABLE audit_events
  ADD COLUMN IF NOT EXISTS organization_id uuid;

UPDATE audit_events ae
   SET organization_id = oai.organization_id
  FROM org_app_index oai
 WHERE ae.app_id = oai.app_id
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
  'Org that owns this event. Backfilled from org_app_index; nullable for rows with no matching app.';
