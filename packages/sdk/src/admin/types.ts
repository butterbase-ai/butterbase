// ── Schema ──

export interface SchemaTable {
  columns: Record<string, SchemaColumn>;
  indexes?: Record<string, SchemaIndex>;
  _dropColumns?: string[];
}

export interface SchemaColumn {
  type: string;
  nullable?: boolean;
  default?: string;
  unique?: boolean;
  references?: string;
}

export interface SchemaIndex {
  columns: string[];
  unique?: boolean;
}

export interface SchemaDefinition {
  tables: Record<string, SchemaTable>;
  _drop?: string[];
}

export interface MigrationResult {
  applied: number;
  statements: string[];
  message: string;
}

export interface Migration {
  id: string;
  name: string;
  applied_at: string;
  statements?: string[];
}

// ── RLS ──

export interface RlsPolicy {
  table_name: string;
  policy_name: string;
  command?: string;
  role?: string;
  restrictive?: boolean;
  using_expression?: string;
  with_check_expression?: string;
}

export interface CreatePolicyParams {
  table_name: string;
  policy_name: string;
  /** Backend defaults to 'ALL' when omitted. */
  command?: 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'ALL';
  role?: 'anon' | 'user';
  restrictive?: boolean;
  user_column?: string;
  using_expression?: string;
  with_check_expression?: string;
}

// ── OAuth ──

export interface OAuthConfig {
  id: string;
  app_id: string;
  provider: string;
  client_id: string;
  redirect_uris: string[];
  scopes?: string[];
  enabled: boolean;
  created_at: string;
}

export interface OAuthConfigParams {
  provider: string;
  client_id: string;
  client_secret: string;
  redirect_uris: string[];
  scopes?: string[];
  authorization_url?: string;
  token_url?: string;
  userinfo_url?: string;
}

// ── App Config ──

export interface AppConfig {
  cors_allowed_origins?: string[];
  jwt_token_ttl?: number;
  storage_used_bytes?: number;
  storage_limit_bytes?: number;
  storage_public_read_enabled?: boolean;
}

export interface CorsConfig {
  /** @deprecated use allowedOrigins (camelCase) */
  allowed_origins?: string[];
  allowedOrigins?: string[];
  allowedMethods?: string[];
  allowedHeaders?: string[];
  allowCredentials?: boolean;
}

export interface JwtConfig {
  /** Duration string, e.g. "15m", "1h". */
  accessTokenTtl?: string;
  refreshTokenTtlDays?: number;
}

export interface StorageConfig {
  publicReadEnabled?: boolean;
  maxFileSizeMb?: number;
  allowedContentTypes?: string[];
}

export interface PausedState {
  app_id: string;
  paused: boolean;
  paused_at: string | null;
  paused_reason: string | null;
}

// ── Functions ──

export type FunctionTriggerType = 'http' | 'cron' | 's3_upload' | 'webhook' | 'websocket';

export interface FunctionTrigger {
  type: FunctionTriggerType;
  config?: Record<string, unknown>;
}

export type AgentToolMode = 'read_only' | 'read_write';
export type AgentToolExposedTo = 'developer_only' | 'end_user';

export interface AgentToolFields {
  /** When true, the function is exposed to agents as a tool. */
  agent_tool?: boolean;
  /** Description shown to the LLM (max 500 chars). */
  agent_tool_description?: string | null;
  /** read_only (default) | read_write. read_write requires HITL approval. */
  agent_tool_mode?: AgentToolMode | null;
  /** developer_only (default) | end_user. */
  agent_tool_exposed_to?: AgentToolExposedTo | null;
}

export interface DeployFunctionParams extends AgentToolFields {
  name: string;
  code: string;
  description?: string;
  envVars?: Record<string, string>;
  timeoutMs?: number;
  memoryLimitMb?: number;
  trigger?: FunctionTrigger;
  /** Canonical multi-trigger array. At most one trigger per type. */
  triggers?: FunctionTrigger[];
  /**
   * Default true. When true, this function accepts an `X-Butterbase-As-User`
   * header from app-scoped service-key callers and treats `ctx.user.id` as
   * the asserted user. Set to false for admin-only or billing-webhook
   * handlers that must never be invoked on behalf of an end-user.
   */
  allow_service_key_impersonation?: boolean;
}

export interface FunctionSummary extends AgentToolFields {
  id: string;
  name: string;
  description?: string;
  url?: string;
  status?: string;
  triggers?: FunctionTrigger[];
  deployedAt?: string;
  lastInvoked?: string;
  lastStatus?: string;
  invocationCount?: number;
  errorRate?: number;
  avgDuration?: number;
  /** Phase 2 impersonation gate. See DeployFunctionParams. */
  allow_service_key_impersonation?: boolean;
}

export interface FunctionDetails extends FunctionSummary {
  envVars?: string[];
  timeoutMs?: number;
  memoryLimitMb?: number;
}

export interface FunctionLog {
  timestamp: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  statusCode?: number;
  error?: string;
  durationMs?: number;
  requestId?: string;
}

export interface LogOptions {
  limit?: number;
  since?: string;
  level?: 'debug' | 'info' | 'warn' | 'error';
  /**
   * Read invocation logs for a soft-deleted function (post-incident forensics).
   * Default: false. Soft-deleted functions are otherwise hidden by the logs route.
   */
  includeDeleted?: boolean;
}

// ── API Keys ──

export interface ApiKey {
  id: string;
  key: string;
  name: string;
  created_at: string;
}

export interface ApiKeySummary {
  id: string;
  name: string;
  prefix: string;
  created_at: string;
  last_used_at?: string;
}

export interface GenerateApiKeyParams {
  name: string;
  scopes?: string[];
}

// ── Audit Logs ──

export interface AuditLog {
  id: string;
  app_id: string;
  category: string;
  event_type: string;
  action?: string;
  resource_type?: string;
  resource_id?: string;
  actor_type?: 'user' | 'service' | 'system';
  actor_id?: string;
  /** Legacy field — older audit rows used user_id; preserved for compatibility. */
  user_id?: string;
  event_data?: Record<string, unknown>;
  /** Legacy field — older audit rows used details; preserved for compatibility. */
  details?: Record<string, any>;
  ip_address?: string;
  user_agent?: string;
  success: boolean;
  error_message?: string | null;
  correlation_id?: string;
  created_at: string;
}

export interface AuditLogQueryOptions {
  category?: string;
  eventType?: string;
  action?: string;
  resourceType?: string;
  resourceId?: string;
  actorId?: string;
  /** ISO date or full timestamp */
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export interface AuditLogPage {
  logs: AuditLog[];
  total: number;
  limit: number;
  offset: number;
  nextOffset?: number | null;
}

// ── Frontend Deployments ──

export interface Deployment {
  id: string;
  app_id: string;
  status: string;
  url?: string;
  framework?: string;
  created_at: string;
  updated_at?: string;
}

export type FrontendFramework = 'react-vite' | 'nextjs-static' | 'static' | 'other';

export interface CreateDeploymentParams {
  framework?: FrontendFramework;
}

export interface DeploymentCreateResponse {
  id: string;
  uploadUrl: string;
  expiresIn: number;
  maxSizeBytes: number;
}

// ── Realtime ──

export interface RealtimeConfig {
  app_id: string;
  tables: Array<{
    table_name: string;
    events: string[];
    enabled: boolean;
    created_at: string;
    updated_at: string;
  }>;
  active_connection: boolean;
  websocket_url: string;
}

export interface RealtimeTableResult {
  table: string;
  status: string;
}

// ── Durable Objects ──

export type AccessMode = 'public' | 'authenticated' | 'service_key';

export interface DurableObjectClass {
  id: string;
  name: string;
  class_name: string;
  status: string;
  access_mode: AccessMode;
  last_deployed_at: string | null;
  error_message: string | null;
  /** Source code — only present on the single-get endpoint */
  code?: string;
  created_at?: string;
  updated_at?: string;
}

export interface RegisterDurableObjectParams {
  name: string;
  code: string;
  access_mode?: AccessMode;
}

export interface DurableObjectUsage {
  do_requests: number;
  do_cpu_ms: number;
}

// ── Edge SSR ──

export interface EdgeSsrDeployment {
  id: string;
  framework: string | null;
  url: string | null;
  status: string;
  error: string | null;
  fileCount: number | null;
  totalSizeBytes: number | null;
  workerScriptSizeBytes: number | null;
  workerScriptModuleCount: number | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string | null;
}

export interface EdgeSsrFromSourceStartParams {
  buildCommand?: string;
  outputDir?: string;
  packageManager?: 'npm' | 'pnpm' | 'yarn';
  lockfileHash: string;
  userEnv?: Record<string, string>;
}

// ── App Config (access-mode / secure) ──

export interface SecureAppTableSpec {
  table_name: string;
  user_column: string;
  public_read_column?: string;
}

export interface SecureAppParams {
  tables?: SecureAppTableSpec[];
}

export interface SecureAppResult {
  message: string;
  app_id: string;
  access_mode: string;
  tables_secured: Array<{ table: string; policy: string; public_read_policies?: string[] }>;
  table_errors?: Array<{ table: string; error: string }>;
}

export interface UpdateAccessModeResult {
  message: string;
  app_id: string;
  access_mode: string;
}

// ── Custom Domains ──

export interface CustomDomain {
  id: string;
  app_id: string;
  hostname: string;
  status: string;
  ssl_status: string;
  domain_type: string;
  is_primary: boolean;
  created_at: string;
  updated_at: string;
}

export interface CustomDomainVerificationRecord {
  status?: string;
  txt_name?: string;
  txt_value?: string;
  http_url?: string;
  http_body?: string;
  cname?: string;
  cname_target?: string;
}

export interface CustomDomainOwnershipVerification {
  type: string;
  name: string;
  value: string;
}

export interface CustomDomainAddResult {
  domain: CustomDomain;
  cname_target: string;
  /** The SSL validation method actually used. 'http' (default) or 'txt'. */
  validation_method?: 'http' | 'txt';
  verification_records?: CustomDomainVerificationRecord[];
  ownership_verification?: CustomDomainOwnershipVerification | null;
  instructions: string;
}

export interface CustomDomainStatus {
  domain: CustomDomain;
  verification: {
    type?: string;
    value?: string;
    errors?: unknown[];
  };
  instructions?: string;
}

// ── App Migrations (multi-region) ──

export type MigrationStep =
  | 'requested' | 'reserving_dest' | 'blocking_writes' | 'dumping_data'
  | 'restoring_data' | 'copying_blobs' | 'copying_runtime' | 'flipping_routing'
  | 'setting_up_reverse_replication' | 'unblocking_writes' | 'completed'
  | 'aborted' | 'failed';

export interface AppMigration {
  migration_id: string;
  current_step: MigrationStep;
  source_region: string;
  dest_region: string;
  source_replica_state?: 'pending' | 'active' | 'torn_down';
  last_error?: string | null;
  retry_count?: number;
  step_started_at?: string;
  completed_at?: string | null;
  progress?: Record<string, unknown>;
}

export interface SourceReplica {
  migration_id: string;
  app_id: string;
  source_region: string;
  dest_region: string;
  state: 'pending' | 'active' | 'torn_down';
  completed_at: string;
}

// ── Platform Billing ──

export interface PlatformBillingStatus {
  plan: { id: string; name: string; price?: number; limits?: Record<string, number> };
  subscription?: { id: string; status: string; current_period_end?: string };
  usage: Record<string, number>;
  usagePercentages: Record<string, number>;
  aiCredits?: { balance: number; ledger?: any[] };
  spendingCap?: { limit: number; period: 'monthly'; alertThreshold?: number };
}

export interface TopupRequest {
  amount_usd: number;
  currency?: string;
}

export interface SpendingCap {
  limit: number;
  period: 'monthly';
  alertThreshold?: number;
}

export type PlatformMeterType =
  | 'api_calls' | 'storage_bytes' | 'ai_tokens' | 'lambda_invocations' | 'bandwidth_bytes';

export interface PlatformUsageOptions {
  startDate?: string;
  endDate?: string;
  meterType?: PlatformMeterType;
}

// ── Frontend from-source ──

export interface FrontendFromSourceCreateResult {
  deployment_id: string;
  build_id: string;
  upload_url: string;
  max_source_bytes: number;
}

export interface FrontendFromSourceStartParams {
  buildCommand?: string;     // default 'npm run build'
  outputDir?: string;        // default 'dist'
  packageManager: 'npm' | 'pnpm' | 'yarn';
  lockfileHash: string;      // 8-64 hex chars (sha256 32 prefix)
  userEnv?: Record<string, string>;
}

export interface FrontendFromSourceStartResult {
  build_id: string;
  status: string;
  logs_url: string;
  status_url: string;
}
