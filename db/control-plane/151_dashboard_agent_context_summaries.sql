-- @scope: platform
-- One structured summary per conversation, plus the watermark of the last
-- message it covers. Raw messages are never deleted; this only changes what
-- the agent replays. Additive and safe to re-run.
CREATE TABLE IF NOT EXISTS dashboard_agent_context_summaries (
  conversation_id UUID PRIMARY KEY
    REFERENCES dashboard_agent_conversations(id) ON DELETE CASCADE,
  summary TEXT NOT NULL,
  through_message_id UUID NOT NULL,
  through_created_at TIMESTAMPTZ NOT NULL,
  source_characters BIGINT NOT NULL,
  summary_characters INTEGER NOT NULL,
  model_used TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
