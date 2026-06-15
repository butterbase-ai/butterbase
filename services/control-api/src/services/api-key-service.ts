import crypto from 'crypto';
import { Pool } from 'pg';
import {
  API_KEY_PREFIX,
  API_KEY_SUBSTRATE_PREFIX,
  API_KEY_RANDOM_LENGTH,
} from '@butterbase/shared/constants';
import type { AuthContext } from '@butterbase/shared/types';
import { getRedisClient } from './redis.js';

const API_KEY_CACHE_TTL = 60;
const API_KEY_INVALID_TTL = 10;
const API_KEY_INVALID_SENTINEL = '__invalid__';
const apiKeyCacheKey = (keyHash: string) => `auth:apikey:${keyHash}`;

/**
 * Known scope values:
 *   '*'           — full access; default for all keys minted today
 *   'ai:gateway'  — grants access to the app-less model gateway endpoints
 *                   (POST /v1/chat/completions, POST /v1/embeddings,
 *                    GET  /v1/models). Use this for keys distributed to
 *                    end users who should only access the gateway, not
 *                    other control-API resources.
 *
 * New scopes can be added without a migration — `scopes` is a TEXT[] column.
 * Route handlers gate access by checking `request.auth.scopes`.
 */

export const ALLOWED_EXTRA_SCOPES = new Set(['ai:gateway', 'substrate']);

export interface GenerateApiKeyOptions {
  keyScope?: 'account' | 'app';                     // default 'account' for back-compat
  targetAppId?: string;                             // required iff keyScope === 'app'
  additionalScopes?: string[];                      // allowlisted
  substrateAccess?: 'app' | 'substrate' | 'both';   // existing axis
}

export class ScopeValidationError extends Error {
  readonly name = 'ScopeValidationError';
  readonly code: 'INVALID_KEY_SCOPE' | 'TARGET_APP_REQUIRED' | 'TARGET_APP_NOT_ALLOWED'
              | 'RESERVED_SCOPE' | 'UNKNOWN_SCOPE';
  constructor(code: ScopeValidationError['code'], message: string) {
    super(message);
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function validateScopeInputs(opts: GenerateApiKeyOptions) {
  const keyScope = opts.keyScope ?? 'account';
  if (keyScope !== 'account' && keyScope !== 'app') {
    throw new ScopeValidationError('INVALID_KEY_SCOPE',
      "key_scope must be 'account' or 'app'");
  }
  if (keyScope === 'app' && !opts.targetAppId) {
    throw new ScopeValidationError('TARGET_APP_REQUIRED',
      "target_app_id is required when key_scope is 'app'");
  }
  if (keyScope === 'account' && opts.targetAppId) {
    throw new ScopeValidationError('TARGET_APP_NOT_ALLOWED',
      "target_app_id must not be set when key_scope is 'account'");
  }
  for (const s of opts.additionalScopes ?? []) {
    if (s === '*' || s.startsWith('app:')) {
      throw new ScopeValidationError('RESERVED_SCOPE',
        `'${s}' is a reserved scope. Use key_scope to control account/app scope instead.`);
    }
    if (!ALLOWED_EXTRA_SCOPES.has(s)) {
      throw new ScopeValidationError('UNKNOWN_SCOPE',
        `'${s}' is not a valid scope. Allowed: ${[...ALLOWED_EXTRA_SCOPES].join(', ')}.`);
    }
  }
}

function buildScopes(opts: GenerateApiKeyOptions): string[] {
  const keyScope = opts.keyScope ?? 'account';
  const extras = opts.additionalScopes ?? [];
  if (keyScope === 'app') {
    if (!opts.targetAppId) {
      throw new Error('BUG: buildScopes called for app scope without targetAppId — validateScopeInputs should have caught this');
    }
    return [`app:${opts.targetAppId}`, 'ai:gateway', ...extras];
  }
  return ['*', ...extras];
}

export class ApiKeyService {
  /**
   * Generate a new API key for a user.
   * Returns the plaintext key ONCE - it's never stored or returned again.
   *
   * Options:
   *   keyScope        — 'account' (default, full-access '*' scopes) or 'app'
   *                     (scopes locked to a specific app via 'app:<id>')
   *   targetAppId     — required when keyScope === 'app'
   *   additionalScopes — extra allowlisted scopes to append (e.g. 'substrate')
   *   substrateAccess — controls the `scope` DB column and key prefix:
   *                     'substrate' emits a bb_sub_-prefixed key; 'app' (default)
   *                     or 'both' emits a bb_sk_-prefixed key.
   */
  static async generateApiKey(
    pool: Pool,
    userId: string,
    name: string,
    options: GenerateApiKeyOptions = {}
  ): Promise<{ key: string; keyId: string; prefix: string; name: string }> {
    validateScopeInputs(options);
    const scopes = buildScopes(options);
    const scope = options.substrateAccess ?? 'app';
    const isSubstrateOnly = scope === 'substrate';
    const isBoth = scope === 'both';
    const prefix = isSubstrateOnly ? API_KEY_SUBSTRATE_PREFIX : API_KEY_PREFIX;

    const randomBytes = crypto.randomBytes(20);
    const randomHex = randomBytes.toString('hex');
    const fullKey = `${prefix}${randomHex}`;
    const keyHash = crypto.createHash('sha256').update(fullKey).digest('hex');
    const keyPrefix = fullKey.substring(0, 12);
    const dbScope = isBoth ? 'both' : (isSubstrateOnly ? 'substrate' : 'app');

    const result = await pool.query(
      `INSERT INTO api_keys
         (user_id, key_hash, key_prefix, name, scopes, scope, substrate_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, name`,
      [userId, keyHash, keyPrefix, name, scopes, dbScope, userId]
    );

    return {
      key: fullKey,
      keyId: result.rows[0].id,
      prefix: keyPrefix,
      name: result.rows[0].name,
    };
  }

  /**
   * Validate an API key and return auth context
   * Returns null if key is invalid, revoked, or expired
   */
  static async validateApiKey(
    pool: Pool,
    rawKey: string
  ): Promise<AuthContext | null> {
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const cacheKey = apiKeyCacheKey(keyHash);

    try {
      const cached = await getRedisClient().get(cacheKey);
      if (cached === API_KEY_INVALID_SENTINEL) return null;
      if (cached) return JSON.parse(cached) as AuthContext;
    } catch {
      // Redis miss/error — fall through to DB
    }

    const result = await pool.query(
      `SELECT id, user_id, scopes, revoked_at, expires_at
       FROM api_keys
       WHERE key_hash = $1`,
      [keyHash]
    );

    if (result.rows.length === 0) {
      getRedisClient().setex(cacheKey, API_KEY_INVALID_TTL, API_KEY_INVALID_SENTINEL).catch(() => {});
      return null;
    }

    const key = result.rows[0];

    if (key.revoked_at) {
      getRedisClient().setex(cacheKey, API_KEY_INVALID_TTL, API_KEY_INVALID_SENTINEL).catch(() => {});
      return null;
    }

    if (key.expires_at && new Date(key.expires_at) < new Date()) {
      getRedisClient().setex(cacheKey, API_KEY_INVALID_TTL, API_KEY_INVALID_SENTINEL).catch(() => {});
      return null;
    }

    const authContext: AuthContext = {
      userId: key.user_id,
      authMethod: 'api_key',
      scopes: key.scopes,
      keyId: key.id,
    };

    getRedisClient().setex(cacheKey, API_KEY_CACHE_TTL, JSON.stringify(authContext)).catch(() => {});

    // Update last_used_at on cache miss only (fire and forget)
    this.updateLastUsed(pool, key.id).catch(() => {});

    return authContext;
  }

  /**
   * List all API keys for a user (never returns hashes)
   * Optionally filter by scope: 'app' | 'substrate'
   */
  static async listKeys(pool: Pool, userId: string, scope?: 'app' | 'substrate' | 'both') {
    const params: unknown[] = [userId];
    let where = `user_id = $1 AND revoked_at IS NULL`;
    if (scope === 'app' || scope === 'substrate' || scope === 'both') {
      params.push(scope);
      where += ` AND scope = $${params.length}`;
    }
    const result = await pool.query(
      `SELECT id, key_prefix, name, scopes, scope, substrate_user_id,
              last_used_at, expires_at, created_at
       FROM api_keys
       WHERE ${where}
       ORDER BY created_at DESC`,
      params
    );

    return result.rows;
  }

  /**
   * Revoke an API key (soft delete)
   */
  static async revokeKey(
    pool: Pool,
    keyId: string,
    userId: string
  ): Promise<boolean> {
    const result = await pool.query(
      `UPDATE api_keys
       SET revoked_at = now()
       WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
       RETURNING id, key_hash`,
      [keyId, userId]
    );

    if (result.rows.length > 0 && result.rows[0].key_hash) {
      getRedisClient().del(apiKeyCacheKey(result.rows[0].key_hash)).catch(() => {});
    }

    return result.rows.length > 0;
  }

  /**
   * Update last_used_at timestamp (fire and forget)
   */
  private static async updateLastUsed(pool: Pool, keyId: string): Promise<void> {
    await pool.query(
      `UPDATE api_keys SET last_used_at = now() WHERE id = $1`,
      [keyId]
    );
  }
}
