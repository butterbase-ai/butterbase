-- @scope: runtime
-- Plan 10.6: drop legacy apps.substrate_user_id.
-- Requires: no code reads apps.substrate_user_id anymore (internal-bridge + auto-mirror
-- were updated in Plan 10.6 Task 7 to select apps.substrate_organization_id only).

DROP INDEX IF EXISTS apps_substrate_user_idx;
ALTER TABLE apps DROP COLUMN IF EXISTS substrate_user_id;
