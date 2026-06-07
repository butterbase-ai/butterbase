/**
 * Per-app runtime tables that the move-app saga copies from source to dest
 * during the copying_runtime step. Source rows are tagged with
 * archived_after_move = <migration_id> and excluded from normal queries via
 * WHERE archived_after_move IS NULL.
 *
 * The boot-time audit in runtime-table-audit.ts asserts that every table
 * with an app_id column in the runtime DB is in either this list or
 * MOVE_APP_EXCLUDED.
 */
export const MOVE_APP_RUNTIME_TABLES = [
  // Identity / auth
  'app_users',
  'app_refresh_tokens',
  'app_verification_codes',
  'app_signing_keys',
  'app_oauth_configs',
  'app_connected_accounts',

  // Domain / routing
  'app_custom_domains',

  // Functions
  'app_functions',
  'function_triggers',
  'function_invocations',

  // Frontend / SSR / Durable Objects
  'app_edge_ssr_deployments',
  'app_durable_objects',
  'app_do_deploy_state',
  'app_do_env_vars',
  'app_frontend_env_vars',

  // Realtime / integrations
  'app_realtime_config',
  'app_integration_configs',
  'oauth_states',

  // Storage
  'storage_objects',

  // Billing per-app
  'app_orders',
  'app_plans',
  'app_products',
  'app_subscriptions',

  // Observability
  'audit_events',
  'ai_usage_logs',
  'ai_video_jobs',
  'mcp_tool_call_log',

  // Deployment + billing history (per-app, follow the app on move)
  'app_deployments',
  'usage_meters',

  // Agents (per-app; child tables agent_checkpoints/agent_run_events/agent_usage/
  // agent_webhook_deliveries reference agent_runs via run_id without app_id and
  // are not copied — in-flight run state is lost on move v1, cascade-cleared
  // when archived agent_runs rows are eventually purged).
  'agents',
  'agent_mcp_servers',
  'agent_runs',
  'agent_tool_audits',
] as const;

/**
 * Tables explicitly NOT moved by the saga. The boot audit requires every
 * table with an app_id column to be either here or in MOVE_APP_RUNTIME_TABLES.
 */
export const MOVE_APP_EXCLUDED: Record<string, string> = {
  // System-wide / not per-app:
  partner_keys: 'system-wide partner credentials, not per-app',
  partner_pools: 'system-wide partner pool config, not per-app',
  partner_proxy_logs: 'operational proxy logs; partner_id context is system-wide, not portable',
  _runtime_migrations: 'migration tracking table',
  user_billing_state: 'per-region cache; Phase 3 reconciles via outbox, do not snapshot/copy',

  // Recreated by the saga, not copied:
  app_db_connections: 'recreated fresh by provisionAppDb on the dest side',

  // Per-region queues — transient state, dest region drives its own work:
  neon_tasks: 'per-region Neon API queue; dest neon-task-worker re-provisions on move',
  rag_ingestion_queue: 'per-region RAG ingestion queue; pending tasks lost on move (acceptable v1)',

};

/**
 * Tables whose primary key is NOT `id`. Used by step-copy-runtime for
 * cursor pagination. Default is `id`.
 */
export const TABLE_PK_OVERRIDES: Record<string, string> = {
  app_do_deploy_state: 'app_id',
  oauth_states: 'state',
};
