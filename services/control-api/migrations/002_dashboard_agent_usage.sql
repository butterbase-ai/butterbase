CREATE TABLE dashboard_agent_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  conversation_id UUID NOT NULL REFERENCES dashboard_agent_conversations(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  prompt_tokens INT NOT NULL DEFAULT 0,
  completion_tokens INT NOT NULL DEFAULT 0,
  tool_calls_count INT NOT NULL DEFAULT 0,
  file_writes_count INT NOT NULL DEFAULT 0,
  deployments_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX dashboard_agent_usage_user_created_idx
  ON dashboard_agent_usage (user_id, created_at DESC);
CREATE INDEX dashboard_agent_usage_conv_idx
  ON dashboard_agent_usage (conversation_id, created_at);
