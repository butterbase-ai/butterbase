-- @scope: runtime
-- Add substrate_organization_id to runtime apps. Logical (not FK-enforced)
-- reference to control-plane organizations(id) — matches the existing
-- cross-plane pattern from 034_apps_organization_id.sql.
--
-- Semantics: NULL = "app is not linked to any org's substrate."
-- Plan 10.2 backfills from apps.substrate_user_id → platform_users.personal_organization_id.
-- Plan 10.6 drops the legacy substrate_user_id column.

ALTER TABLE apps
  ADD COLUMN IF NOT EXISTS substrate_organization_id uuid;

CREATE INDEX IF NOT EXISTS apps_substrate_org_id_idx
  ON apps (substrate_organization_id) WHERE substrate_organization_id IS NOT NULL;

COMMENT ON COLUMN apps.substrate_organization_id IS
  'Logical reference to control-plane organizations(id). Set when this app is linked to an org substrate (auto-propagate reads/writes route to it). NULL = not linked.';
