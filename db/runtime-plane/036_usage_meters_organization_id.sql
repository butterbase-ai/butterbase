-- @scope: runtime
-- Plan 11.1: add organization_id to runtime usage_meters. Distinct from the
-- control-plane usage_meters table (Plan 07 already fixed that one). Logical
-- cross-plane reference to control-plane organizations(id) — matches the
-- existing pattern from 034_apps_organization_id.sql.

ALTER TABLE usage_meters
  ADD COLUMN IF NOT EXISTS organization_id uuid;

CREATE INDEX IF NOT EXISTS usage_meters_organization_id_idx
  ON usage_meters (organization_id) WHERE organization_id IS NOT NULL;

COMMENT ON COLUMN usage_meters.organization_id IS
  'Logical reference to control-plane organizations(id). Nullable until Plan 11.5. Backfilled via app_id → apps.organization_id in Plan 11.2.';
