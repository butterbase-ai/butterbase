-- @scope: platform
-- Apply before deploying eight-decimal lease arithmetic. Existing balances
-- retain their value; future small charges must not round away on settlement.
-- These type changes take table locks. Fail quickly rather than queue behind
-- live billing traffic; the transaction can be retried in a quiet window.
SET LOCAL lock_timeout = '5s';

ALTER TABLE organizations
  ALTER COLUMN credits_usd TYPE NUMERIC(20,8),
  ALTER COLUMN monthly_allowance_usd TYPE NUMERIC(20,8);

ALTER TABLE credit_leases
  ALTER COLUMN amount_usd TYPE NUMERIC(20,8),
  ALTER COLUMN settled_amount_usd TYPE NUMERIC(20,8),
  ALTER COLUMN topup_amount_usd TYPE NUMERIC(20,8);

ALTER TABLE monthly_credit_resets
  ALTER COLUMN previous_unspent_usd TYPE NUMERIC(20,8);
