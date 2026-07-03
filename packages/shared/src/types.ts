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
  /**
   * - 'api_key'        — platform bb_sk_* key (user-managed, full app + substrate access)
   * - 'jwt'            — Cognito/local platform JWT (dashboard/CLI users)
   * - 'end_user_jwt'   — app end-user JWT (signed by the app's signing key)
   * - 'function_key'   — per-app BUTTERBASE_FUNCTION_SERVICE_KEY (auto-injected
   *                      into Deno runtime; bound to a single app; scoped to
   *                      a small allowlist of routes — see auth.ts).
   * - 'anonymous'      — no token / unrecognised token
   */
  authMethod: 'api_key' | 'jwt' | 'end_user_jwt' | 'function_key' | 'anonymous';
  scopes: string[];
  keyId?: string;
  email?: string;
  appId?: string;   // Required when authMethod === 'function_key'; informational otherwise.
  rawToken?: string;
  /**
   * The organization this request is scoped to.
   * - API-key auth: `api_keys.organization_id` (org the key was minted under).
   * - JWT auth: caller's `platform_users.personal_organization_id`.
   * - `end_user_jwt`, `function_key`, `anonymous`: null.
   * Absent → the fallback path in downstream code (e.g. substrate overlay)
   * may resolve via a control-DB lookup.
   */
  organizationId?: string | null;
}

/**
 * Caller identity surfaced as `ctx.caller` inside a deployed function.
 *
 * Populated from the validated Authorization header at the control-api edge
 * (or filled with `{ type: 'anonymous', ... }` when no bearer was present).
 * User code SHOULD prefer reading this over decoding `req.headers.authorization`
 * by hand — the platform has already done the cryptographic checks.
 *
 * Identity propagation rule of thumb:
 *   - `type === 'end_user_jwt'`: `userId` is the app-user who hit the endpoint.
 *     `ctx.user.id` is set; `keyId`/`scope` are null.
 *   - `type === 'service_key'`: a `bb_sk_*` key authenticated the request.
 *     `keyId` is the row id of the key (safe to log/audit, never the secret).
 *     `scope` is one of the key's `app:<app_id>` / `ai:gateway` entries —
 *     useful for "is this an app-scoped caller?" checks.
 *   - `type === 'anonymous'`: no bearer, or the bearer was invalid/revoked.
 */
export interface FunctionCaller {
  /**
   * - `service_key` — user-managed bb_sk_*
   * - `end_user_jwt` — an app end-user
   * - `loopback` — same-app ctx.invoke from a sibling function
   * - `anonymous` — no/invalid bearer
   */
  type: 'service_key' | 'end_user_jwt' | 'loopback' | 'anonymous';
  /** API-key row id (e.g. `ak_…`). Present iff `type === 'service_key'`. */
  keyId: string | null;
  /** First app- or gateway-scope on the key (e.g. `app:app_xyz`). */
  scope: string | null;
  /**
   * The user this request is acting *on behalf of*. For `end_user_jwt` this is
   * the JWT subject; for `service_key` it is null today (Phase 2 enables an
   * impersonation header that populates this).
   */
  userId: string | null;
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
