-- @scope: runtime
-- Plan 11.1: add organization_id to app end-user tables. These tables key on
-- an app end user (customer of the app, NOT a Butterbase member), but every
-- row descends from an app which is org-owned (Plan 04). Denormalizing
-- organization_id enables per-org queries without an apps join.

ALTER TABLE app_refresh_tokens
  ADD COLUMN IF NOT EXISTS organization_id uuid;
CREATE INDEX IF NOT EXISTS app_refresh_tokens_organization_id_idx
  ON app_refresh_tokens (organization_id) WHERE organization_id IS NOT NULL;
COMMENT ON COLUMN app_refresh_tokens.organization_id IS
  'Denormalized from apps.organization_id via app_id. Nullable until Plan 11.5.';

ALTER TABLE app_verification_codes
  ADD COLUMN IF NOT EXISTS organization_id uuid;
CREATE INDEX IF NOT EXISTS app_verification_codes_organization_id_idx
  ON app_verification_codes (organization_id) WHERE organization_id IS NOT NULL;
COMMENT ON COLUMN app_verification_codes.organization_id IS
  'Denormalized from apps.organization_id via app_id. Nullable until Plan 11.5.';

ALTER TABLE app_subscriptions
  ADD COLUMN IF NOT EXISTS organization_id uuid;
CREATE INDEX IF NOT EXISTS app_subscriptions_organization_id_idx
  ON app_subscriptions (organization_id) WHERE organization_id IS NOT NULL;
COMMENT ON COLUMN app_subscriptions.organization_id IS
  'Denormalized from apps.organization_id via app_id. Nullable until Plan 11.5.';

ALTER TABLE app_orders
  ADD COLUMN IF NOT EXISTS organization_id uuid;
CREATE INDEX IF NOT EXISTS app_orders_organization_id_idx
  ON app_orders (organization_id) WHERE organization_id IS NOT NULL;
COMMENT ON COLUMN app_orders.organization_id IS
  'Denormalized from apps.organization_id via app_id. Nullable until Plan 11.5.';
