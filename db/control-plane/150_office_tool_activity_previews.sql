-- @scope: platform
-- Optional, sanitized tool observations. No transcript backfill or execution state.
CREATE TABLE IF NOT EXISTS office_tool_activity_invocations (
  id UUID PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES dashboard_agent_conversations(id) ON DELETE CASCADE,
  user_message_id UUID NOT NULL REFERENCES dashboard_agent_messages(id) ON DELETE CASCADE,
  provider_call_id TEXT CHECK (length(provider_call_id) BETWEEN 1 AND 256),
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  tool_name TEXT NOT NULL CHECK (length(tool_name) BETWEEN 1 AND 128),
  action TEXT CHECK (length(action) BETWEEN 1 AND 100),
  step JSONB NOT NULL CHECK (jsonb_typeof(step)='object' AND octet_length(step::text)<=12288),
  approval_id UUID,
  durable_turn_id UUID,
  durable_refs JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(durable_refs)='array' AND jsonb_array_length(durable_refs)<=8),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(conversation_id,user_message_id,ordinal)
);
CREATE INDEX IF NOT EXISTS office_tool_activity_history_idx ON office_tool_activity_invocations(conversation_id,user_message_id,ordinal);
CREATE INDEX IF NOT EXISTS office_tool_activity_approval_idx ON office_tool_activity_invocations(conversation_id,approval_id) WHERE approval_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS office_tool_activity_turn_idx ON office_tool_activity_invocations(durable_turn_id) WHERE durable_turn_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS office_tool_activity_previews (
  invocation_id UUID NOT NULL REFERENCES office_tool_activity_invocations(id) ON DELETE CASCADE,
  phase TEXT NOT NULL CHECK (phase IN ('call','tool_result','approval_resolution')),
  preview JSONB NOT NULL CHECK (jsonb_typeof(preview)='object' AND octet_length(preview::text)<=12288),
  observed_status TEXT NOT NULL CHECK (observed_status IN ('running','completed','failed','awaiting_approval','denied','interrupted','unknown')),
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  policy_version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(invocation_id,phase)
);
