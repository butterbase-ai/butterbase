-- @scope: platform
-- Additive evidence for activity-opted-in website turns. No historical backfill.
CREATE TABLE IF NOT EXISTS dashboard_agent_office_turns (
  user_message_id UUID PRIMARY KEY REFERENCES dashboard_agent_messages(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES dashboard_agent_conversations(id) ON DELETE CASCADE,
  outcome TEXT NOT NULL CHECK (outcome IN ('running','completed','awaiting_approval','failed','interrupted','unknown')),
  final_answer_id UUID REFERENCES dashboard_agent_messages(id) ON DELETE SET NULL,
  approval_id UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dashboard_agent_office_turns_approval_idx
  ON dashboard_agent_office_turns(conversation_id,approval_id) WHERE approval_id IS NOT NULL;
