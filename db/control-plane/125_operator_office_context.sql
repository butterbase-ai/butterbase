-- @scope: platform
-- Additive generic operator context. Existing keys and dashboard conversations
-- retain their prior behavior after migration.

ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS organization_locked BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE dashboard_agent_conversations
  ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'dashboard';

ALTER TABLE dashboard_agent_approvals
  ADD COLUMN IF NOT EXISTS approved_operation JSONB;
