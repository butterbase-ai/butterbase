-- @scope: runtime
-- 029_ai_responses.sql
-- Responses API state table for chaining previous_response_id.
-- Stores LLM responses with related metadata for the Responses API.

CREATE TABLE IF NOT EXISTS ai_responses (
  id TEXT PRIMARY KEY,
  created_at BIGINT NOT NULL,
  previous_response_id TEXT NULL REFERENCES ai_responses(id) ON DELETE SET NULL,
  model TEXT NOT NULL,
  input_messages JSONB NOT NULL,
  output JSONB NOT NULL,
  usage JSONB NOT NULL,
  status TEXT NOT NULL,
  expires_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS ai_responses_expires_at_idx ON ai_responses(expires_at);
CREATE INDEX IF NOT EXISTS ai_responses_previous_idx ON ai_responses(previous_response_id);
