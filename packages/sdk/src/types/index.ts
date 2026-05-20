import type { SessionStorage } from '../auth/session-storage.js';

// Core types
export interface ButterbaseClientOptions {
  appId: string;
  apiUrl: string;
  anonKey?: string;
  onUnauthorized?: () => void; // Called on 401 responses
  /** Custom session storage adapter. Defaults to localStorage with memory fallback. */
  sessionStorage?: SessionStorage;
  /** Set to false to disable automatic session persistence. Defaults to true. */
  persistSession?: boolean;
  /** Automatically detect OAuth tokens from the URL on client creation. Defaults to true in browser environments. */
  detectSessionFromUrl?: boolean;
}

// Re-export session types
export type {
  AuthEvent,
  AuthChangeCallback,
  Subscription,
} from '../auth/session-manager.js';

export interface ButterbaseResponse<T> {
  data: T | null;
  /**
   * Present when the request failed. When the backend returned a recognizable
   * agent-friendly error, this is a typed `ButterbaseError` subclass
   * (`AuthError`, `ValidationError`, `NotFoundError`, `QuotaError`, `NetworkError`)
   * with `code`, `status`, and `remediation` fields. For unexpected throws
   * (e.g. fetch failures), this is the raw `Error`.
   */
  error: Error | null;
}

// Auth types
export interface User {
  id: string;
  email: string;
  email_verified: boolean;
  display_name?: string;
  avatar_url?: string;
  provider?: string;
  created_at: string;
  last_sign_in_at?: string;
  metadata?: Record<string, any>;
}

export interface Session {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  user: User;
}

export interface SignUpParams {
  email: string;
  password: string;
  metadata?: Record<string, any>;
}

export interface SignInParams {
  email: string;
  password: string;
}

export interface AuthResponse {
  user: User;
  session: Session;
}

// Actual API response from login endpoint
export interface LoginResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  user: User;
}

// Signup response (no tokens)
export interface SignupResponse {
  user: User;
  message: string;
}

export interface OAuthParams {
  provider: string;
  redirectTo: string;
}

export interface OAuthCallbackResult {
  user: User;
  session: Session;
}

// Storage types
export interface StorageObject {
  id: string;
  user_id?: string | null;
  object_key: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  /** Set on upload; not always returned by list. */
  public?: boolean;
  created_at: string;
}

export interface UploadResponse {
  objectId: string;
  objectKey: string;
}

export interface DownloadUrlResponse {
  url: string;
  filename: string;
}

// Query builder types
export type QueryOperator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'ilike' | 'in' | 'is';

export interface QueryFilter {
  column: string;
  operator: QueryOperator;
  value: any;
}

export interface OrderByOptions {
  ascending?: boolean;
}

// Function invocation types
export interface InvokeFunctionOptions {
  body?: any;
  headers?: Record<string, string>;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
}

// Re-export AI types
export type {
  ChatMessage, ChatOptions, ChatCompletion, ChatStreamChunk, AiConfig, AiUsage,
  EmbeddingRequest, EmbeddingResponse, EmbeddingVector, AiModel,
} from '../ai/types.js';

// Re-export Billing types
export type {
  Plan, CreatePlanParams, Product, CreateProductParams,
  Subscription as BillingSubscription, SubscribeParams, CheckoutSession, PurchaseParams, PurchaseResult,
  Order, ConnectOnboardResult, ConnectStatus,
} from '../billing/types.js';

// Re-export Admin types
export type {
  SchemaTable, SchemaColumn, SchemaIndex, SchemaDefinition, MigrationResult, Migration,
  RlsPolicy, CreatePolicyParams,
  OAuthConfig, OAuthConfigParams,
  AppConfig, CorsConfig, JwtConfig,
  DeployFunctionParams, FunctionDetails, FunctionSummary, FunctionLog, LogOptions,
  ApiKey, ApiKeySummary, GenerateApiKeyParams,
  AuditLog, AuditLogQueryOptions, AuditLogPage,
  Deployment, CreateDeploymentParams, DeploymentCreateResponse, FrontendFramework,
  RealtimeConfig, RealtimeTableResult,
  CustomDomain, CustomDomainAddResult, CustomDomainStatus,
  AppMigration, SourceReplica, MigrationStep,
  PlatformBillingStatus, TopupRequest, SpendingCap, PlatformMeterType, PlatformUsageOptions,
  FrontendFromSourceCreateResult, FrontendFromSourceStartParams, FrontendFromSourceStartResult,
} from '../admin/types.js';
