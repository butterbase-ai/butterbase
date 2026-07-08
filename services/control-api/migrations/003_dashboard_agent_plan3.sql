ALTER TABLE dashboard_agent_messages
  ADD COLUMN IF NOT EXISTS model_used TEXT;
