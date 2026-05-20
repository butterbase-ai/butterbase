-- @scope: runtime
-- 010: Add router-awareness columns to ai_usage_logs.
-- These columns are populated by the multi-router gateway (Plan B).
-- Added in Plan A so the schema is stable when Plan B ships without
-- requiring a coordinated cross-plane deploy.

BEGIN;

ALTER TABLE ai_usage_logs
  ADD COLUMN IF NOT EXISTS router               TEXT NOT NULL DEFAULT 'openrouter',
  ADD COLUMN IF NOT EXISTS provider_cost_usd    NUMERIC(12,6),
  ADD COLUMN IF NOT EXISTS charged_credits_usd  NUMERIC(12,6),
  ADD COLUMN IF NOT EXISTS markup_pct           NUMERIC(6,3),
  ADD COLUMN IF NOT EXISTS fallback_chain       TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS lease_id             UUID;

CREATE INDEX IF NOT EXISTS ai_usage_logs_router_idx
  ON ai_usage_logs (router, created_at DESC);

COMMENT ON COLUMN ai_usage_logs.router IS
  'Upstream router selected for this call. One of openrouter|provider-primary|provider-secondary.';
COMMENT ON COLUMN ai_usage_logs.fallback_chain IS
  'Routers attempted before success, in order. Empty array on first-attempt success.';
COMMENT ON COLUMN ai_usage_logs.lease_id IS
  'credit_leases.lease_id used to gate this call (cross-DB, informational only — no FK).';

COMMIT;
