import crypto from 'crypto';
import { Pool } from 'pg';
import { API_KEY_PREFIX, API_KEY_RANDOM_LENGTH } from '@butterbase/shared/constants';
import type { AuthContext } from '@butterbase/shared/types';
import { getRedisClient } from './redis.js';

const API_KEY_CACHE_TTL = 60;
const API_KEY_INVALID_TTL = 10;
const API_KEY_INVALID_SENTINEL = '__invalid__';
const apiKeyCacheKey = (keyHash: string) => `auth:apikey:${keyHash}`;

/**
 * Known scope values:
 *   '*'              — full access for the key's own user. Does NOT grant
 *                      cross-user access: an `*` key minted by Alice can only
 *                      hit Alice's own apps. To delegate access to a specific
 *                      app owned by someone else, use the `app:<appId>` scope.
 *   'ai:gateway'     — grants access to the app-less model gateway endpoints
 *                      (POST /v1/chat/completions, POST /v1/embeddings,
 *                       GET  /v1/models). Use this for keys distributed to
 *                       end users who should only access the gateway, not
 *                       other control-API resources.
 *   'app:<appId>'    — grants access to the per-app AI routes
 *                      (POST /v1/:appId/{chat,embeddings,videos}/completions)
 *                      for that one appId, **billing the app owner**. Use this
 *                      when a developer wants to mint a key for a third-party
 *                      integrator without granting full account access.
 *
 * New scopes can be added without a migration — `scopes` is a TEXT[] column.
 * Route handlers gate access by checking `request.auth.scopes`.
 */
export class ApiKeyService {
  /**
   * Generate a new API key for a user
   * Returns the plaintext key ONCE - it's never stored or returned again
   */
  static async generateApiKey(
    pool: Pool,
    userId: string,
    name: string,
    scopes: string[] = ['*']
  ): Promise<{ key: string; keyId: string; prefix: string; name: string }> {
    // Generate random key: bb_sk_ + 40 hex chars
    const randomBytes = crypto.randomBytes(20);
    const randomHex = randomBytes.toString('hex');
    const fullKey = `${API_KEY_PREFIX}${randomHex}`;

    // Hash for storage
    const keyHash = crypto.createHash('sha256').update(fullKey).digest('hex');

    // Prefix for display (first 12 chars)
    const keyPrefix = fullKey.substring(0, 12);

    // Store in database
    const result = await pool.query(
      `INSERT INTO api_keys (user_id, key_hash, key_prefix, name, scopes)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name`,
      [userId, keyHash, keyPrefix, name, scopes]
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
  static async listKeys(pool: Pool, userId: string, scope?: 'app' | 'substrate') {
    const params: unknown[] = [userId];
    let where = `user_id = $1 AND revoked_at IS NULL`;
    if (scope === 'app' || scope === 'substrate') {
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
