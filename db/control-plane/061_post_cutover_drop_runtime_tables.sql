-- @scope: platform
--
-- Phase 2 cutover: drop runtime tables from the control (platform) DB.
-- These tables now live in per-region runtime DBs (NEON_RUNTIME_PROJECT_ID_<REGION>).
--
-- This migration MUST NOT be applied until:
--   1. Code has been deployed reading from runtime DB (Tasks 9–13).
--   2. scripts/migrate-runtime-data.ts has run successfully for every region.
--   3. Operator has verified production functions normally for >= 24 hours.
--
-- Apply by running: npm run migrate:control
-- Rollback: restore from backup. There is no automated rollback.

-- Order: drop dependent tables first (FK-pointed-to last)
DROP TABLE IF EXISTS function_invocations CASCADE;
DROP TABLE IF EXISTS function_triggers CASCADE;
DROP TABLE IF EXISTS app_functions CASCADE;
DROP TABLE IF EXISTS agent_webhook_deliveries CASCADE;
DROP TABLE IF EXISTS agent_usage CASCADE;
DROP TABLE IF EXISTS agent_tool_audits CASCADE;
DROP TABLE IF EXISTS agent_run_events CASCADE;
DROP TABLE IF EXISTS agent_checkpoints CASCADE;
DROP TABLE IF EXISTS agent_runs CASCADE;
DROP TABLE IF EXISTS agent_mcp_servers CASCADE;
DROP TABLE IF EXISTS agents CASCADE;
DROP TABLE IF EXISTS partner_proxy_logs CASCADE;
DROP TABLE IF EXISTS partner_keys CASCADE;
DROP TABLE IF EXISTS partner_pools CASCADE;
DROP TABLE IF EXISTS mcp_tool_call_log CASCADE;
DROP TABLE IF EXISTS ai_usage_logs CASCADE;
DROP TABLE IF EXISTS dispatcher_cursors CASCADE;
DROP TABLE IF EXISTS storage_objects CASCADE;
DROP TABLE IF EXISTS app_orders CASCADE;
DROP TABLE IF EXISTS app_subscriptions CASCADE;
DROP TABLE IF EXISTS app_products CASCADE;
DROP TABLE IF EXISTS app_plans CASCADE;
DROP TABLE IF EXISTS app_realtime_config CASCADE;
DROP TABLE IF EXISTS app_integration_configs CASCADE;
DROP TABLE IF EXISTS app_edge_ssr_deployments CASCADE;
DROP TABLE IF EXISTS app_do_deploy_state CASCADE;
DROP TABLE IF EXISTS app_do_env_vars CASCADE;
DROP TABLE IF EXISTS app_durable_objects CASCADE;
DROP TABLE IF EXISTS app_frontend_env_vars CASCADE;
DROP TABLE IF EXISTS app_custom_domains CASCADE;
DROP TABLE IF EXISTS oauth_states CASCADE;
DROP TABLE IF EXISTS app_connected_accounts CASCADE;
DROP TABLE IF EXISTS app_oauth_configs CASCADE;
DROP TABLE IF EXISTS app_signing_keys CASCADE;
DROP TABLE IF EXISTS app_verification_codes CASCADE;
DROP TABLE IF EXISTS app_refresh_tokens CASCADE;
DROP TABLE IF EXISTS app_users CASCADE;
DROP TABLE IF EXISTS app_db_connections CASCADE;
DROP TABLE IF EXISTS apps CASCADE;
-- audit_events: see runbook for handling the actor_type split
