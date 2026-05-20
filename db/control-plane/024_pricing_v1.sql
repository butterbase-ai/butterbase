-- @scope: platform
-- Pricing Model V1: Playground / Launch / Certified / Enterprise
-- - Rename free→playground, pro→launch, add certified tier
-- - Add spending caps, top-up credit packs, per-tier overage rates
-- - Free tier AI credits become monthly (not lifetime)
-- - Max projects limit per tier

-- ============================================================
-- 1. Add new columns to plans table
-- ============================================================

ALTER TABLE plans ADD COLUMN IF NOT EXISTS max_projects INTEGER NOT NULL DEFAULT -1;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS default_spending_cap_usd NUMERIC(10,2) DEFAULT NULL;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS ai_overage_rate_usd NUMERIC(10,4) DEFAULT NULL;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS stripe_price_id TEXT DEFAULT NULL;

-- ============================================================
-- 2. Add spending cap + top-up balance to platform_users
-- ============================================================

ALTER TABLE platform_users
  ADD COLUMN IF NOT EXISTS spending_cap_usd NUMERIC(10,2) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS topup_balance_usd NUMERIC(10,4) NOT NULL DEFAULT 0;

-- ============================================================
-- 3. Create credit top-ups ledger
-- ============================================================

CREATE TABLE IF NOT EXISTS credit_topups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  amount_usd NUMERIC(10,2) NOT NULL,
  stripe_payment_intent_id TEXT,
  status TEXT NOT NULL DEFAULT 'completed',  -- completed, refunded
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_credit_topups_user_id ON credit_topups(user_id);

-- ============================================================
-- 4. Rename plans: free→playground, pro→launch
--    Must update foreign key references first
-- ============================================================

-- 4a. Insert new plan rows (playground, launch) with temp data
--     so we can update FK references before deleting old rows.

INSERT INTO plans (id, name, price_monthly_cents, max_apps, max_api_calls_monthly,
                   max_storage_gb, max_ai_tokens_monthly, max_lambda_invocations,
                   max_db_size_gb, max_bandwidth_gb, max_mau, max_ai_credits_usd,
                   ai_credits_lifetime, overage_rates, features,
                   max_projects, default_spending_cap_usd, ai_overage_rate_usd)
VALUES
-- Playground (replaces free)
('playground', 'Playground', 0, -1, -1,
 1, -1, 50000,
 0.5, 5, 10000, 1.00,
 false, '{}',
 '{"custom_domain": false, "priority_support": false}',
 1, NULL, NULL),

-- Launch (replaces pro)
('launch', 'Launch', 1900, -1, -1,
 50, -1, 500000,
 4, 100, 50000, 5.00,
 false,
 '{"ai_credits": 0.10, "mau": 0.00325, "database_gb": 0.125, "bandwidth_gb": 0.09, "storage_gb": 0.021}',
 '{"custom_domain": true, "priority_support": false}',
 3, 20.00, 0.10),

-- Certified (new tier)
('certified', 'Certified', 9000, -1, -1,
 100, -1, 1000000,
 8, 250, 100000, 15.00,
 false,
 '{"ai_credits": 0.08, "mau": 0.00325, "database_gb": 0.125, "bandwidth_gb": 0.09, "storage_gb": 0.021}',
 '{"custom_domain": true, "priority_support": true}',
 10, 50.00, 0.08)

ON CONFLICT (id) DO NOTHING;

-- 4b. Migrate users and subscriptions from old plan IDs to new ones

UPDATE platform_users SET plan_id = 'playground' WHERE plan_id = 'free';
UPDATE platform_users SET plan_id = 'launch' WHERE plan_id = 'pro';

UPDATE subscriptions SET plan_id = 'playground' WHERE plan_id = 'free';
UPDATE subscriptions SET plan_id = 'launch' WHERE plan_id = 'pro';

UPDATE plans SET ai_credits_lifetime = true WHERE id = 'playground';

-- 4c. Set default spending caps for existing paid users

UPDATE platform_users SET spending_cap_usd = 20.00
WHERE plan_id = 'launch' AND spending_cap_usd IS NULL;

UPDATE platform_users SET spending_cap_usd = 50.00
WHERE plan_id = 'certified' AND spending_cap_usd IS NULL;

-- 4d. Update the default plan_id on platform_users from 'free' to 'playground'

ALTER TABLE platform_users ALTER COLUMN plan_id SET DEFAULT 'playground';

-- 4e. Delete old plan rows (no more FK references)

DELETE FROM plans WHERE id = 'free';
DELETE FROM plans WHERE id = 'pro';

-- ============================================================
-- 5. Update enterprise plan with new columns
-- ============================================================

UPDATE plans SET
  max_projects = -1,
  default_spending_cap_usd = NULL,
  ai_overage_rate_usd = NULL,
  max_mau = -1,
  max_ai_credits_usd = -1,
  ai_credits_lifetime = false,
  overage_rates = '{}',
  features = '{"custom_domain": true, "priority_support": true, "sla": true, "dedicated_support": true, "soc2": true, "sso": true, "hipaa_addon": true}'
WHERE id = 'enterprise';
