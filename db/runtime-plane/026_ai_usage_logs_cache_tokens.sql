-- @scope: runtime
-- 026: Add cache token columns to ai_usage_logs.
-- Tracks Anthropic prompt-caching token counts so dashboards and billing
-- can distinguish warm-cache reads from full prompt ingestion.
-- Both columns default to 0 so existing rows and non-Anthropic adapters
-- require no backfill — they simply report zero cache activity.

ALTER TABLE ai_usage_logs
  ADD COLUMN IF NOT EXISTS cache_read_input_tokens     BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cache_creation_input_tokens BIGINT NOT NULL DEFAULT 0;

COMMENT ON COLUMN ai_usage_logs.cache_read_input_tokens IS
  'Tokens served from the Anthropic prompt cache (read hit). 0 for non-Anthropic models.';
COMMENT ON COLUMN ai_usage_logs.cache_creation_input_tokens IS
  'Tokens written into the Anthropic prompt cache. 0 for non-Anthropic models.';
