-- @scope: runtime
-- Drop dead column agents.byok_override.
--
-- Background: the agent feature (salvaged migration 051_agent_runtime.sql,
-- folded into 001_initial_runtime_schema.sql at line ~226) added a
-- byok_override TEXT column intended to override an app's default AI key
-- per agent. The Python agent-runtime never reads it; control-api agent
-- routes never read it; only the dashboard's AgentEditorPage wrote to it
-- via apiClient.updateAiConfig({ byokKey }).
--
-- That dashboard UI has been removed. BYOK as a user-facing concept no
-- longer exists for agents, so the column is now unreferenced. Drop it.

ALTER TABLE public.agents DROP COLUMN IF EXISTS byok_override;
