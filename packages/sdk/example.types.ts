// Smoke import — verifies plan 1 surface compiles
import type {
  FunctionTrigger,
  FunctionTriggerType,
  AuditLog,
  AuditLogPage,
  AuditLogQueryOptions,
  JwtConfig,
  CreatePolicyParams,
  ChatMessage,
  ChatContentPart,
  QueryResult,
  StorageObject,
  ConnectedAccount,
  CreateDeploymentParams,
  DeploymentCreateResponse,
  FrontendFramework,
} from './src';
import {
  AdminDurableObjectsClient,
  AdminEdgeSsrClient,
} from './src';
const _t = { AdminDurableObjectsClient, AdminEdgeSsrClient };

// Plan 2 additions
import {
  consumeSse,
  computeLockfileHash,
  AdminMigrationsClient,
  AdminPlatformBillingClient,
} from './src';
import type {
  SseEvent, LockfileResult, FileReader,
  AppMigration, SourceReplica, MigrationStep,
  PlatformBillingStatus, TopupRequest, SpendingCap, PlatformMeterType, PlatformUsageOptions,
  EmbeddingRequest, EmbeddingResponse, EmbeddingVector, AiModel,
  FrontendFromSourceCreateResult, FrontendFromSourceStartParams, FrontendFromSourceStartResult,
  GenerateApiKeyParams,
} from './src';
const _p2 = {
  consumeSse, computeLockfileHash,
  AdminMigrationsClient, AdminPlatformBillingClient,
};
