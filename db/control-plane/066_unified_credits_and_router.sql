-- @scope: platform
-- 066: Unified prepaid credits ledger + scaffolding for multi-router AI gateway.
--
-- Renames:
--   platform_users.topup_balance_usd  → platform_users.credits_usd
--   topup_leases                       → credit_leases
--   user_billing_state.topup_lease_remaining_usd → user_billing_state.credits_lease_remaining_usd
--
-- New columns on plans (subscribe/renewal grants):
--   signup_credit_grant_usd, monthly_credit_grant_usd
-- Old columns max_ai_credits_usd / ai_credits_lifetime stay for one release
-- so the backfill script can read them; they are dropped in 067.
--
-- New auto-refill columns on platform_users; consumed in Plan C.
--
-- New table credit_grants (audit + Stripe idempotency).
--
-- New columns on credit_leases: settled_amount_usd, settled_at, status='settled'.

BEGIN;

-- 1. platform_users column renames + auto-refill scaffolding
ALTER TABLE platform_users
  RENAME COLUMN topup_balance_usd TO credits_usd;

ALTER TABLE platform_users
  ADD COLUMN IF NOT EXISTS auto_refill_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS auto_refill_amount_usd NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS auto_refill_last_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS auto_refill_last_failure_reason TEXT;

-- 2. plans grant columns
ALTER TABLE plans
  ADD COLUMN IF NOT EXISTS signup_credit_grant_usd  NUMERIC(10,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS monthly_credit_grant_usd NUMERIC(10,4) NOT NULL DEFAULT 0;

-- 3. credit_leases (renamed from topup_leases) + settle columns
ALTER TABLE topup_leases RENAME TO credit_leases;

ALTER TABLE credit_leases
  ADD COLUMN IF NOT EXISTS settled_amount_usd NUMERIC(10,4),
  ADD COLUMN IF NOT EXISTS settled_at         TIMESTAMPTZ;

-- 4. user_billing_state column rename (if the table exists; created by an earlier migration)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'user_billing_state' AND column_name = 'topup_lease_remaining_usd'
  ) THEN
    ALTER TABLE user_billing_state RENAME COLUMN topup_lease_remaining_usd TO credits_lease_remaining_usd;
  END IF;
END $$;

-- 5. credit_grants
CREATE TABLE IF NOT EXISTS credit_grants (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  plan_id         TEXT REFERENCES plans(id),
  amount_usd      NUMERIC(10,4) NOT NULL CHECK (amount_usd > 0),
  reason          TEXT NOT NULL CHECK (reason IN ('signup','renewal','auto_refill','manual','refund')),
  stripe_event_id TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS credit_grants_stripe_event_id_uniq
  ON credit_grants (stripe_event_id) WHERE stripe_event_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS credit_grants_signup_per_user_uniq
  ON credit_grants (user_id) WHERE reason = 'signup';

CREATE INDEX IF NOT EXISTS credit_grants_user_created_idx
  ON credit_grants (user_id, created_at DESC);

COMMENT ON TABLE credit_grants IS
  'Additive credit grants (signup / Stripe renewal / auto-refill / manual). Unique-on-stripe_event_id prevents webhook double-fires; unique-on-user_id-where-signup makes signup grant exactly-once.';

COMMIT;
