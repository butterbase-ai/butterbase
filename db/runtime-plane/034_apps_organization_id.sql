-- @scope: runtime
-- 034_apps_organization_id.sql
-- Adds a logical organization_id to the runtime apps table. Cross-plane
-- reference to control-DB organizations.id — NOT FK-enforced (same pattern
-- as apps.owner_id today).
-- Nullable in this migration; NOT NULL constraint follows in plan 04 after
-- backfill (plan 02) verifies every row has an organization_id.
-- Design: docs/superpowers/specs/2026-07-01-organizations-design.md

ALTER TABLE apps
  ADD COLUMN IF NOT EXISTS organization_id uuid;

CREATE INDEX IF NOT EXISTS apps_organization_id_created_at_idx
  ON apps (organization_id, created_at DESC);

COMMENT ON COLUMN apps.organization_id IS
  'Logical reference to control-DB organizations.id. NOT NULL enforced after backfill in plan 02.';
