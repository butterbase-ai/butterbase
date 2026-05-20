export interface PlatformUser {
  id: string;
  email: string;
  password_hash: string;
  display_name: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface App {
  id: string;
  name: string;
  owner_id: string;
  db_name: string;
  db_provisioned: boolean;
  region: string;
  created_at: Date;
  updated_at: Date;
}

export interface AppUser {
  id: string;
  app_id: string;
  email: string;
  password_hash: string | null;
  provider: string;
  provider_uid: string | null;
  metadata: Record<string, unknown>;
  email_verified: boolean;
  display_name: string | null;
  avatar_url: string | null;
  last_sign_in_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface StorageObject {
  id: string;
  app_id: string;
  bucket: string;
  key: string;
  size_bytes: number | null;
  mime_type: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
}

export interface AiUsageLog {
  id: string;
  app_id: string;
  model: string;
  provider: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost_usd: number | null;
  request_metadata: Record<string, unknown>;
  created_at: Date;
}

export interface InitRequest {
  name: string;
  owner_id?: string;
}

export interface InitResponse {
  app_id: string;
  name: string;
  database: {
    host: string;
    port: number;
    name: string;
    user: string;
    connection_string: string;
  };
  api_url: string;
  created_at: string;
  _meta?: {
    next_actions?: Array<{
      action: string;
      description: string;
      recommended: boolean;
    }>;
  };
}

export interface ApiKey {
  id: string;
  user_id: string;
  key_prefix: string;
  name: string;
  scopes: string[];
  last_used_at?: Date;
  expires_at?: Date;
  revoked_at?: Date;
  created_at: Date;
}

export interface AuthContext {
  userId: string | null;  // Allow null for anonymous
  authMethod: 'api_key' | 'jwt' | 'end_user_jwt' | 'anonymous';  // Add anonymous
  scopes: string[];
  keyId?: string;
  email?: string;
  appId?: string;
  rawToken?: string;
}

export interface AppSigningKey {
  id: string;
  app_id: string;
  kid: string;
  algorithm: string;
  private_key_encrypted: string;
  public_key: string;
  active: boolean;
  created_at: Date;
}

export interface AppOAuthConfig {
  id: string;
  app_id: string;
  provider: string;
  client_id: string;
  client_secret_encrypted: string | null;
  scopes: string[];
  authorization_url: string | null;
  token_url: string | null;
  userinfo_url: string | null;
  enabled: boolean;
}

export interface AppRefreshToken {
  id: string;
  app_id: string;
  user_id: string;
  token_hash: string;
  expires_at: Date;
  revoked_at: Date | null;
}

export interface EndUserClaims {
  sub: string;
  email: string;
  email_verified: boolean;
  app_id: string;
  iat: number;
  exp: number;
  iss: string;
}

export interface EndUserAuthContext {
  userId: string;
  appId: string;
  email: string;
  emailVerified: boolean;
}

export interface RealtimeEvent {
  type: 'change';
  table: string;
  op: 'INSERT' | 'UPDATE' | 'DELETE';
  record: Record<string, unknown> | null;
  old_record: Record<string, unknown> | null;
  timestamp: string;
}

export * from './error-types.js';
export * from './response-types.js';
