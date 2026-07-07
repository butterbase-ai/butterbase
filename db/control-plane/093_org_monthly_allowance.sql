-- @scope: platform
-- 093: Move monthly credit allowance from per-user to per-org.
--
-- Prior model (migration 067): platform_users.monthly_allowance_usd — a single
-- pool per user, shared across every org the user is a member of. This
-- conflated personal-org billing with team-org billing:
--   * downgrading a personal-org paid sub left the user-level $5 in place,
--     so the dashboard kept showing the credit indefinitely
--   * the same user-level $5 rendered on every org card the user could see,
--     making it look like credit "duplicated" across orgs
--   * a paid team-org sub still ran the reset against personal_organization_id
--     (see stripe-service.ts handleInvoicePaid), so its allowance leaked back
--     into the personal pool instead of the team org's own balance
--
-- New model: organizations.monthly_allowance_usd. Every subscription is
-- per-org, so the allowance follows the sub. handleInvoicePaid /
-- handleSubscriptionUpdated key on subscription.organization_id and reset
-- THAT org's row.
--
-- Backfill preserves existing user balances by moving them to the user's
-- personal org (the only org that could have been the source under the old
-- model). Team orgs start at 0.
--
-- The per-user column is not dropped in this migration — a follow-up removes
-- it after readers/writers are cut over (see phase 7). During the interim
-- writers dual-write for safety; readers prefer the org column.

BEGIN;

-- 1. New column, defaults to 0 so pre-existing orgs (team orgs, playground)
--    start with no phantom allowance.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS monthly_allowance_usd NUMERIC(10,4) NOT NULL DEFAULT 0;

-- 2. Backfill from personal orgs only. A user's monthly_allowance_usd came
--    from resetMonthlyAllowance events whose subject was always their
--    personal org, so the personal org is the correct destination.
--    UPDATE is idempotent (rerun-safe) because it copies the current value.
UPDATE organizations o
   SET monthly_allowance_usd = pu.monthly_allowance_usd
  FROM platform_users pu
 WHERE pu.personal_organization_id = o.id
   AND pu.monthly_allowance_usd > 0
   AND o.monthly_allowance_usd = 0;  -- don't clobber a value another writer set

-- 3. monthly_credit_resets.organization_id already exists (added earlier);
--    no schema change here. The Stripe handler is patched separately to
--    populate it for every reset going forward.

COMMIT;
