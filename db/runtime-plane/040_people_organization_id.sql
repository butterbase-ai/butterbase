-- @scope: runtime
-- Plan 11.1: add organization_id to CRM/people tables. Each row descends from
-- an app (via app_id or via a people row that has app_id), and the owning
-- app is org-scoped (Plan 04). Denormalize for query efficiency.
-- Note: people base table does not exist yet in runtime plane; backfill plan
-- (Plan 11.2) will handle creation if needed. Migrating the actual people-related tables.

ALTER TABLE people_email_lookups
  ADD COLUMN IF NOT EXISTS organization_id uuid;
CREATE INDEX IF NOT EXISTS people_email_lookups_organization_id_idx
  ON people_email_lookups (organization_id) WHERE organization_id IS NOT NULL;
COMMENT ON COLUMN people_email_lookups.organization_id IS
  'Denormalized from apps.organization_id via app_id. Nullable until Plan 11.5.';

ALTER TABLE people_usage_logs
  ADD COLUMN IF NOT EXISTS organization_id uuid;
CREATE INDEX IF NOT EXISTS people_usage_logs_organization_id_idx
  ON people_usage_logs (organization_id) WHERE organization_id IS NOT NULL;
COMMENT ON COLUMN people_usage_logs.organization_id IS
  'Denormalized from apps.organization_id via app_id. Nullable until Plan 11.5.';
