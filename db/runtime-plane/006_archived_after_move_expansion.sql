-- @scope: runtime
-- Phase 6: archived_after_move tag for Phase-6-added move-app runtime tables.
-- Idempotent (ADD COLUMN IF NOT EXISTS).

DO $$
DECLARE
  t TEXT;
  tables TEXT[] := ARRAY[
    'app_connected_accounts',
    'function_invocations',
    'app_do_deploy_state',
    'app_do_env_vars',
    'app_frontend_env_vars',
    'oauth_states',
    'audit_events',
    'ai_usage_logs',
    'mcp_tool_call_log'
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
