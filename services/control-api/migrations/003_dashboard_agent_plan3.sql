ALTER TABLE dashboard_agent_messages
  ADD COLUMN IF NOT EXISTS model_used TEXT;

CREATE TABLE IF NOT EXISTS dashboard_agent_snapshot_labels (
  conversation_id UUID NOT NULL REFERENCES dashboard_agent_conversations(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  label TEXT NOT NULL,
  auto_generated BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (conversation_id, app_id, snapshot_id)
);

CREATE TABLE IF NOT EXISTS dashboard_agent_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES dashboard_agent_conversations(id) ON DELETE CASCADE,
  turn_message_id UUID NOT NULL,
  tool_name TEXT NOT NULL,
  tool_args JSONB NOT NULL,
  sensitivity TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  trust_scope TEXT,
  deny_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS dashboard_agent_approvals_conv_status_idx
  ON dashboard_agent_approvals (conversation_id, status);
