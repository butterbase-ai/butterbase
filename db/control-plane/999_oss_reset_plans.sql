-- @scope: platform
-- OSS-only: zero out commercial price points on the `plans` table so the
-- distribution doesn't ship the managed offering's tier pricing. Plan ids
-- are kept so existing FKs (sponsor_codes.plan_id, subscriptions.plan_id, etc.)
-- stay valid; self-hosters can replace pricing with their own values.
UPDATE plans SET
  price_monthly_cents = 0,
  max_apps = -1,
  max_api_calls_monthly = -1,
  max_storage_gb = -1,
  max_ai_tokens_monthly = -1,
  max_lambda_invocations = -1,
  max_db_size_gb = -1,
  max_bandwidth_gb = -1;

-- Strip optional pricing columns added by later migrations if they exist.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='plans' AND column_name='default_spending_cap_usd') THEN
    EXECUTE 'UPDATE plans SET default_spending_cap_usd = NULL';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='plans' AND column_name='ai_overage_rate_usd') THEN
    EXECUTE 'UPDATE plans SET ai_overage_rate_usd = NULL';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='plans' AND column_name='stripe_price_id') THEN
    EXECUTE 'UPDATE plans SET stripe_price_id = NULL';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='plans' AND column_name='signup_credit_grant_usd') THEN
    EXECUTE 'UPDATE plans SET signup_credit_grant_usd = 1';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='plans' AND column_name='monthly_credit_grant_usd') THEN
    EXECUTE 'UPDATE plans SET monthly_credit_grant_usd = 0';
  END IF;
END $$;
