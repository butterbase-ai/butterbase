-- @scope: runtime
-- Phase 2 (agent-feature salvage): add archived_after_move snapshot tag to the
-- agent runtime tables now that they're being moved by the move-app saga.
--
-- The agent_* tables themselves were pre-staged in 001_initial_runtime_schema.sql
-- alongside the rest of the agent runtime schema (covering source migrations
-- 051/052/053/054/058/059 from the agents branch). This migration only adds
-- the move-app snapshot column to the four agent tables that carry app_id
-- directly. Child tables (agent_checkpoints, agent_run_events, agent_usage,
-- agent_webhook_deliveries) reference agent_runs via run_id without app_id and
-- are intentionally NOT moved — in-flight child state is lost on cross-region
-- move v1 and cascade-cleared when archived agent_runs rows are eventually
-- purged.

DO $$
DECLARE
  t TEXT;
  tables TEXT[] := ARRAY[
    'agents',
    'agent_mcp_servers',
    'agent_runs',
    'agent_tool_audits'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = t) THEN
      EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS archived_after_move UUID', t);
      EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (archived_after_move) WHERE archived_after_move IS NOT NULL',
        t || '_archived_idx', t);
    END IF;
  END LOOP;
END $$;
