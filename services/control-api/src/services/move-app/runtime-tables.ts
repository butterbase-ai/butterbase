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
  'app_env_vars',
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
  'actor_usage_logs',
  'mcp_tool_call_log',
  'people_usage_logs',
  'people_profile_cache',

  // Deployment + billing history (per-app, follow the app on move)
  'app_deployments',
  'usage_meters',

  // Agents — parent tables that carry app_id directly.
  // Child tables that reference agent_runs(id) are listed in
  // MOVE_APP_RUNTIME_CHILD_TABLES and copied in a follow-up pass.
  'agents',
  'agent_mcp_servers',
  'agent_runs',
  'agent_tool_audits',
] as const;

/**
 * Per-app runtime tables that don't carry app_id directly but FK into a parent
 * in MOVE_APP_RUNTIME_TABLES. Copied by step-copy-runtime in a second pass,
 * filtered by `parent_fk IN (SELECT id FROM parent WHERE app_id=$1
 *   AND (archived_after_move IS NULL OR archived_after_move=$migration_id))`
 * so we catch rows whose parent was already archived in this same migration.
 *
 * Every entry's child table must have an `archived_after_move uuid` column
 * (added by migration 021 for the four current entries); source-side rows are
 * tagged at the end of the per-table copy so a re-run is idempotent.
 *
 * The boot-time audit in runtime-table-audit.ts asserts that every table in
 * the runtime DB with a FK to a registered parent's PK is in either this list
 * or MOVE_APP_EXCLUDED_CHILD.
 */
export interface MoveAppChildTable {
  /** Child table name. */
  table: string;
  /** Parent table name (must appear in MOVE_APP_RUNTIME_TABLES). */
  parent: string;
  /** Column on the child that references parent's primary key. */
  parent_fk: string;
}

export const MOVE_APP_RUNTIME_CHILD_TABLES: readonly MoveAppChildTable[] = [
  { table: 'agent_checkpoints',        parent: 'agent_runs', parent_fk: 'run_id' },
  { table: 'agent_run_events',         parent: 'agent_runs', parent_fk: 'run_id' },
  { table: 'agent_usage',              parent: 'agent_runs', parent_fk: 'run_id' },
  { table: 'agent_webhook_deliveries', parent: 'agent_runs', parent_fk: 'run_id' },
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
  people_email_lookups: 'pending rows reference a people-search webhook callback URL pinned to source region; copying would orphan in-flight lookups. Acceptable v1 — moves are infrequent, pending lookups complete within seconds.',

};

/**
 * Tables whose primary key is NOT `id`. Used by step-copy-runtime for
 * cursor pagination. Default is `id`.
 */
export const TABLE_PK_OVERRIDES: Record<string, string> = {
  app_do_deploy_state: 'app_id',
  oauth_states: 'state',
};

/**
 * Child tables (FK-linked to a registered parent) that are deliberately NOT
 * moved by the saga. The boot audit requires every FK-to-parent-PK table to
 * be either here or in MOVE_APP_RUNTIME_CHILD_TABLES.
 *
 * Currently empty — every FK-to-parent table is moved. Add an entry here only
 * with a reason and an owning issue.
 */
export const MOVE_APP_EXCLUDED_CHILD: Record<string, string> = {};
