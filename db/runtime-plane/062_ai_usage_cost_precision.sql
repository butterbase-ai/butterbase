-- @scope: runtime
-- Keep AI usage costs at the same precision as credit settlements so a small
-- billed charge does not appear as zero in the usage/reconciliation record.
SET LOCAL lock_timeout = '5s';

ALTER TABLE ai_usage_logs
  ALTER COLUMN provider_cost_usd TYPE NUMERIC(20,8),
  ALTER COLUMN charged_credits_usd TYPE NUMERIC(20,8),
  ALTER COLUMN cost_usd TYPE NUMERIC(20,8);
