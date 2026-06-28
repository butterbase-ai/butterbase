-- @scope: runtime
-- 030: Add reasoning_tokens column to ai_usage_logs.
-- Tracks tokens consumed by reasoning/thinking models (e.g. o1, claude thinking)
-- so dashboards and billing can distinguish reasoning overhead from standard
-- completion tokens. Nullable because most models do not produce reasoning tokens
-- and no backfill of existing rows is needed.

ALTER TABLE ai_usage_logs ADD COLUMN IF NOT EXISTS reasoning_tokens INTEGER;

COMMENT ON COLUMN ai_usage_logs.reasoning_tokens IS
  'Tokens consumed by internal reasoning/thinking steps (o1, claude thinking, etc.). NULL for non-reasoning models.';
