-- @scope: platform
-- 067: Split credit ledger into two pools.
--
--   platform_users.monthly_allowance_usd  — granted by plan; SET on renewal,
--                                            never incremented. Use it or lose it.
--   platform_users.credits_usd            — topup pool (existing column,
--                                            preserved). Only grows via topup
--                                            purchases / manual / auto-refill.
--
-- credit_leases gains source_pool + topup_amount_usd so split-pool leases
-- can be settled and reclaimed back to the correct pools.
--
-- New table monthly_credit_resets records each Stripe-renewal SET event
-- idempotently. credit_grants no longer accepts reason='renewal'.

BEGIN;

-- 1. Monthly pool on platform_users.
ALTER TABLE platform_users
  ADD COLUMN IF NOT EXISTS monthly_allowance_usd NUMERIC(10,4) NOT NULL DEFAULT 0;

-- 2. credit_leases gains pool tracking.
ALTER TABLE credit_leases
  ADD COLUMN IF NOT EXISTS source_pool TEXT NOT NULL DEFAULT 'topup'
    CHECK (source_pool IN ('monthly', 'topup', 'split')),
  ADD COLUMN IF NOT EXISTS topup_amount_usd NUMERIC(10,4);
-- topup_amount_usd is only meaningful when source_pool='split'; otherwise NULL.
-- For monthly-only leases, the lease.amount_usd is the monthly draw.
-- For topup-only leases, the lease.amount_usd is the topup draw.
-- For split leases, lease.amount_usd is the total and topup_amount_usd is the
-- topup portion (monthly portion = amount_usd - topup_amount_usd).

-- 3. New table: monthly_credit_resets (audit + Stripe idempotency).
CREATE TABLE IF NOT EXISTS monthly_credit_resets (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  plan_id         TEXT REFERENCES plans(id),
  amount_usd      NUMERIC(10,4) NOT NULL CHECK (amount_usd >= 0),
  previous_unspent_usd NUMERIC(10,4) NOT NULL DEFAULT 0,
  stripe_event_id TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS monthly_credit_resets_stripe_event_id_uniq
  ON monthly_credit_resets (stripe_event_id) WHERE stripe_event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS monthly_credit_resets_user_created_idx
  ON monthly_credit_resets (user_id, created_at DESC);

COMMENT ON TABLE monthly_credit_resets IS
  'One row per monthly allowance SET event (Stripe renewal or manual). previous_unspent_usd records what was lost; amount_usd is the new monthly_allowance_usd value after the SET.';

-- 4. Drop 'renewal' from credit_grants.reason CHECK. Migrate any existing
--    renewal grants into monthly_credit_resets so audit history is preserved.
INSERT INTO monthly_credit_resets (user_id, plan_id, amount_usd, stripe_event_id, created_at)
SELECT user_id, plan_id, amount_usd, stripe_event_id, created_at
FROM credit_grants WHERE reason = 'renewal';

DELETE FROM credit_grants WHERE reason = 'renewal';

ALTER TABLE credit_grants DROP CONSTRAINT IF EXISTS credit_grants_reason_check;
ALTER TABLE credit_grants ADD CONSTRAINT credit_grants_reason_check
  CHECK (reason IN ('signup','auto_refill','manual','refund'));

COMMIT;
