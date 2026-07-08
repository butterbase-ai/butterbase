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
