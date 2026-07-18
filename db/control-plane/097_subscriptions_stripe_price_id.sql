-- @scope: platform
-- 097: Add subscriptions.stripe_price_id to close the schema gap surfaced by
-- the admin /admin/organizations/:id/plan handler.
--
-- Prior state:
--   - `plans.stripe_price_id` (migration 024) holds the DEFAULT Stripe price
--     for a plan tier — used for standard (launch/certified/etc.) checkouts.
--   - Enterprise plans need a PER-ORG price override (a custom-negotiated
--     dollar amount lives on Stripe as a Price whose product has
--     `metadata.butterbase_plan_id = 'enterprise'`). Historically that
--     override existed only on Stripe; nothing in the control plane stored
--     the per-org price ID.
--   - The admin dashboard's "assign enterprise price to org" flow shipped
--     assuming this column existed. Without it, the handler 500s on every
--     write.
--
-- Nullable — most rows won't set it (standard tiers fall back to
-- `plans.stripe_price_id`); only enterprise-priced orgs will.

BEGIN;

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS stripe_price_id TEXT;

COMMENT ON COLUMN subscriptions.stripe_price_id IS
  'Per-org Stripe Price override. NULL means the org is billed at the default price for plans.stripe_price_id. Set only for enterprise (custom-negotiated) orgs.';

COMMIT;
