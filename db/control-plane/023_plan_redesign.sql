-- @scope: platform
-- Redesign billing plans: Free ($0) / Pro ($25) / Enterprise (custom)
-- Switch from token-based AI limits to dollar-based AI credits
-- Add MAU tracking and overage rates for Pro plan
-- Free tier: AI credits are a LIFETIME allowance (not monthly)
-- Pro tier: AI credits reset each billing period (no rollover)

-- Add new columns
ALTER TABLE plans ADD COLUMN IF NOT EXISTS max_mau INTEGER NOT NULL DEFAULT -1;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS max_ai_credits_usd NUMERIC(10,4) NOT NULL DEFAULT -1;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS ai_credits_lifetime BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS overage_rates JSONB DEFAULT '{}';

-- Remove starter plan (foreign key: downgrade any starter users to free first)
UPDATE platform_users SET plan_id = 'free' WHERE plan_id = 'starter';
UPDATE subscriptions SET plan_id = 'free' WHERE plan_id = 'starter';
DELETE FROM plans WHERE id = 'starter';

-- Update free plan
UPDATE plans SET
  price_monthly_cents = 0,
  max_apps = -1,
  max_api_calls_monthly = -1,
  max_storage_gb = 1,
  max_ai_tokens_monthly = -1,
  max_ai_credits_usd = 0.10,
  ai_credits_lifetime = true,
  max_lambda_invocations = 50000,
  max_db_size_gb = 0.5,
  max_bandwidth_gb = 5,
  max_mau = 50000,
  overage_rates = '{}',
  features = '{"custom_domain": false, "priority_support": false, "sla": false}'
WHERE id = 'free';

-- Update pro plan
UPDATE plans SET
  price_monthly_cents = 2500,
  max_apps = -1,
  max_api_calls_monthly = -1,
  max_storage_gb = 100,
  max_ai_tokens_monthly = -1,
  max_ai_credits_usd = 10.00,
  ai_credits_lifetime = false,
  max_lambda_invocations = 500000,
  max_db_size_gb = 8,
  max_bandwidth_gb = 250,
  max_mau = 100000,
  overage_rates = '{"ai_credits": 0.10, "mau": 0.00325, "database_gb": 0.125, "bandwidth_gb": 0.09, "storage_gb": 0.021}',
  features = '{"custom_domain": true, "priority_support": true}'
WHERE id = 'pro';

-- Update enterprise plan
UPDATE plans SET
  max_apps = -1,
  max_api_calls_monthly = -1,
  max_storage_gb = -1,
  max_ai_tokens_monthly = -1,
  max_ai_credits_usd = -1,
  max_lambda_invocations = -1,
  max_db_size_gb = -1,
  max_bandwidth_gb = -1,
  max_mau = -1,
  overage_rates = '{}',
  features = '{"custom_domain": true, "priority_support": true, "sla": true, "dedicated_support": true, "soc2": true, "sso": true, "hipaa_addon": true}'
WHERE id = 'enterprise';
