export type AuditCategory = 'auth' | 'admin' | 'function' | 'billing';

export type AuditAction =
  | 'create'
  | 'update'
  | 'delete'
  | 'invoke'
  | 'enable'
  | 'disable'
  | 'denied';

export type AuditResourceType =
  | 'app'
  | 'app_user'
  | 'app_config'
  | 'schema'
  | 'rls'
  | 'rls_policy'
  | 'function'
  | 'oauth_provider'
  | 'storage_object'
  | 'api_key'
  | 'deployment'
  | 'realtime'
  | 'ai_config'
  | 'rag_collection'
  | 'rag_document'
  | 'custom_domain'
  | 'durable_object'
  | 'ai_request';

export type AuditActorType =
  | 'platform_user'
  | 'app_user'
  | 'api_key'
  | 'system'
  | 'anonymous';

// Legacy auth event types (kept for the deprecation shim)
export type LegacyAuthEventType =
  | 'signup'
  | 'signup_failed'
  | 'login'
  | 'login_failed'
  | 'logout'
  | 'email_verified'
  | 'password_reset_requested'
  | 'password_reset_completed'
  | 'refresh_token_used'
  | 'refresh_token_failed'
  | 'oauth_login'
  | 'oauth_login_failed';

export interface AuditEventInput {
  appId: string;
  category: AuditCategory;
  eventType: string;
  action?: AuditAction;
  resourceType?: AuditResourceType;
  resourceId?: string;
  actorType: AuditActorType;
  actorId?: string | null;
  eventData?: Record<string, unknown>;
  ipAddress?: string | null;
  userAgent?: string | null;
  success: boolean;
  errorMessage?: string | null;
  correlationId?: string | null;
}
