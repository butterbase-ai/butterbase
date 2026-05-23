// Main client
export { ButterbaseClient, createClient } from './lib/butterbase-client.js';

// Query builder
export { QueryBuilder } from './lib/query-builder.js';

// Mutation builders
export { InsertBuilder, UpdateBuilder, DeleteBuilder } from './lib/mutation-builders.js';

// Utility helpers
export { computeLockfileHash, type LockfileResult, type FileReader } from './lib/lockfile-hash.js';
export { consumeSse, type SseEvent } from './lib/sse.js';

// KV config helper
export { defineKvConfig, type KvConfigInput, type KvExposeRule, type KvRole } from './kv-config.js';

// Client modules
export { AuthClient } from './auth/auth-client.js';
export { StorageClient } from './storage/storage-client.js';
export { FunctionsClient } from './functions/functions-client.js';
export { AiClient } from './ai/ai-client.js';
export { BillingClient } from './billing/billing-client.js';
export { RagClient } from './rag/rag-client.js';
export { IntegrationsClient } from './integrations/integrations-client.js';
export { PartnersClient } from './partners/partners-client.js';

// Admin client
export { AdminClient } from './admin/admin-client.js';
export { AdminSchemaClient } from './admin/schema-client.js';
export { AdminRlsClient } from './admin/rls-client.js';
export { AdminOAuthClient } from './admin/oauth-client.js';
export { AdminConfigClient } from './admin/config-client.js';
export { AdminFunctionsClient } from './admin/functions-client.js';
export { AdminApiKeysClient } from './admin/api-keys-client.js';
export { AdminAuditLogsClient } from './admin/audit-logs-client.js';
export { AdminFrontendClient } from './admin/frontend-client.js';
export { AdminRealtimeClient } from './admin/realtime-client.js';
export { AdminDomainsClient } from './admin/domains-client.js';
export { AdminDurableObjectsClient } from './admin/durable-objects-client.js';
export { AdminEdgeSsrClient } from './admin/edge-ssr-client.js';
export { AdminMigrationsClient } from './admin/migrations-client.js';
export { AdminPlatformBillingClient } from './admin/platform-billing-client.js';

// Realtime client
export { RealtimeClient } from './realtime/realtime-client.js';

// Error types
export {
  ButterbaseError,
  AuthError,
  ValidationError,
  NotFoundError,
  QuotaError,
  NetworkError,
  parseApiError,
  // KV error classes
  KvError,
  KvAuthError,
  KvForbiddenError,
  KvNotFoundError,
  KvKeyInvalidError,
  KvConnectionError,
  KvCasMismatchError,
  KvExposeConflictError,
  KvValueTooLargeError,
  KvQuotaExceededError,
  KvRateLimitedError,
  KvCreditsExhaustedError,
  KvStorageFullError,
  KvKeysExhaustedError,
} from './errors/index.js';

// Shared package re-exports
export {
  ErrorCodes,
  isAgentFriendlyError,
} from '@butterbase/shared';
export type { ErrorCode, AgentFriendlyError } from '@butterbase/shared';
export {
  parseRegions,
  loadRegionConfig,
  butterbaseRegionToFlyRegion,
} from '@butterbase/shared';

// Session persistence
export { SessionManager } from './auth/session-manager.js';
export { LocalSessionStorage, MemorySessionStorage, detectSessionStorage } from './auth/session-storage.js';
export type { SessionStorage } from './auth/session-storage.js';

// Types
export type {
  ButterbaseClientOptions,
  ButterbaseResponse,
  User,
  Session,
  SignUpParams,
  SignInParams,
  AuthResponse,
  LoginResponse,
  SignupResponse,
  OAuthParams,
  OAuthCallbackResult,
  StorageObject,
  UploadResponse,
  DownloadUrlResponse,
  QueryOperator,
  QueryFilter,
  OrderByOptions,
  InvokeFunctionOptions,
  AuthEvent,
  AuthChangeCallback,
  Subscription,
  // AI types
  ChatMessage, ChatOptions, ChatCompletion, ChatStreamChunk, AiConfig, AiUsage,
  EmbeddingRequest, EmbeddingResponse, EmbeddingVector, AiModel,

  // Billing types
  Plan, CreatePlanParams, Product, CreateProductParams,
  BillingSubscription, CheckoutSession, SubscribeParams, PurchaseParams, PurchaseResult,
  Order, ConnectOnboardResult, ConnectStatus,
  // Admin types
  SchemaTable, SchemaColumn, SchemaIndex, SchemaDefinition, MigrationResult, Migration,
  RlsPolicy, CreatePolicyParams,
  OAuthConfig, OAuthConfigParams,
  AppConfig, CorsConfig, JwtConfig,
  DeployFunctionParams, FunctionDetails, FunctionSummary, FunctionLog, LogOptions,
  ApiKey, ApiKeySummary,
  AuditLog, AuditLogQueryOptions,
  Deployment, CreateDeploymentParams,
  // Realtime admin types
  RealtimeConfig, RealtimeTableResult,
  // Custom domain types
  CustomDomain, CustomDomainAddResult, CustomDomainStatus,
  // Platform billing types
  PlatformBillingStatus, TopupRequest, SpendingCap, PlatformMeterType, PlatformUsageOptions,
} from './types/index.js';

// Integration types
export type {
  IntegrationConfig as IntegrationConfigType,
  AvailableIntegration, ConnectedAccount as ConnectedAccountType,
  IntegrationTool, ToolResult,
  ConfigureOptions, ConnectOptions, ConnectResult, ListAvailableOptions,
} from './integrations/types.js';

// Partners types
export type {
  PartnerListItem, PartnerListResponse,
} from './partners/types.js';

// RAG types
export type {
  Collection, CollectionDetails, RagDocument, IngestResult,
  QueryChunk, QueryResult,
  CreateCollectionOptions, IngestOptions, QueryOptions,
} from './rag/types.js';

// Realtime types
export type {
  RealtimeStatus, RealtimeChange, PresenceEvent,
  ChangeCallback, PresenceCallback, StatusCallback,
  RealtimeSubscription,
} from './realtime/types.js';
