import { randomBytes, createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { NotFoundError } from './api-errors.js';

const KV_PASSWORD_BYTES = 24;

export interface KvCredential {
  app_id: string;
  region: string;
  redis_password: string;
  kv_function_key: string;
  created_at: Date;
  rotated_at: Date;
}

type Queryable = Pool | PoolClient;

export class KvCredentialsService {
  constructor(private readonly db: Queryable) {}

  async provision(appId: string, region: string): Promise<KvCredential> {
    const password = randomBytes(KV_PASSWORD_BYTES).toString('hex');
    const functionKey = randomBytes(KV_PASSWORD_BYTES).toString('hex');
    const ins = await this.db.query<KvCredential>(
      `INSERT INTO app_kv_credentials (app_id, region, redis_password, kv_function_key)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (app_id) DO NOTHING
       RETURNING *`,
      [appId, region, password, functionKey],
    );
    if (ins.rows.length > 0) return ins.rows[0];
    // Conflict — credential already exists; return the existing row unchanged.
    // The newly-generated `password` and `functionKey` are intentionally discarded so the credentials
    // stay stable across retried provisioning attempts. To change the password, use `rotate()`.
    const sel = await this.db.query<KvCredential>(
      `SELECT * FROM app_kv_credentials WHERE app_id = $1`,
      [appId],
    );
    return sel.rows[0];
  }

  async lookup(appId: string): Promise<KvCredential | null> {
    const { rows } = await this.db.query<KvCredential>(
      `SELECT * FROM app_kv_credentials WHERE app_id = $1`,
      [appId],
    );
    return rows[0] ?? null;
  }

  /**
   * Validates that `apiKey` is an active dev API key whose owner also owns `appId`.
   * Returns `{ app_id, region }` (and `redis_password` if a KV credential exists) on success,
   * or `null` if the key is invalid/expired, or the key owner does not own the app.
   */
  async resolveDevApiKeyForApp(
    apiKey: string,
    appId: string,
  ): Promise<{ app_id: string; region: string; redis_password: string | null } | null> {
    const keyHash = createHash('sha256').update(apiKey).digest('hex');
    const { rows } = await this.db.query<{
      app_id: string;
      region: string;
      redis_password: string | null;
      key_valid: boolean;
      owns_app: boolean;
    }>(
      `SELECT
         ak.user_id IS NOT NULL  AS key_valid,
         oai.app_id IS NOT NULL  AS owns_app,
         oai.app_id              AS app_id,
         oai.region              AS region,
         kv.redis_password
       FROM api_keys ak
       LEFT JOIN org_app_index oai
         ON oai.app_id = $2
         AND oai.organization_id = ak.organization_id
       LEFT JOIN app_kv_credentials kv ON kv.app_id = oai.app_id
       WHERE ak.key_hash = $1
         AND ak.revoked_at IS NULL
         AND (ak.expires_at IS NULL OR ak.expires_at > now())
       LIMIT 1`,
      [keyHash, appId],
    );
    if (rows.length === 0) return null;
    const row = rows[0];
    if (!row.owns_app) return null;
    return { app_id: row.app_id, region: row.region, redis_password: row.redis_password };
  }

  /**
   * Returns the per-app KV connection info for anonymous/JWT callers.
   * Mirrors the logic behind GET /v1/internal/kv/anon-credentials/:app_id.
   */
  async anonCredentialsFor(
    appId: string,
  ): Promise<{ app_id: string; region: string; redis_password: string } | null> {
    const cred = await this.lookup(appId);
    if (!cred) return null;
    return { app_id: cred.app_id, region: cred.region, redis_password: cred.redis_password };
  }

  /**
   * Validates that `plaintextKey` is the function key for `appId`.
   * Returns connection info on match, null on mismatch.
   * Mirrors the fallback in POST /v1/internal/kv/resolve-key.
   */
  async resolveFunctionKey(
    plaintextKey: string,
    appId: string,
  ): Promise<{ app_id: string; region: string; redis_password: string } | null> {
    const { rows } = await this.db.query<{
      app_id: string;
      region: string;
      redis_password: string;
    }>(
      `SELECT app_id, region, redis_password
       FROM app_kv_credentials
       WHERE kv_function_key = $1 AND app_id = $2`,
      [plaintextKey, appId],
    );
    return rows[0] ?? null;
  }

  /**
   * Like resolveFunctionKey, but also returns the app owner's user_id for use
   * as AuthContext.userId when this key authenticates a request from the Deno
   * runtime. The owner_id is sourced from org_app_index (the control-DB
   * owner-lookup table) joined to platform_users, and matches the userId that
   * a bb_sk_* minted by that owner would carry.
   */
  async resolveFunctionKeyWithOwner(
    plaintextKey: string,
    appId: string,
  ): Promise<{ app_id: string; owner_id: string; organization_id: string | null } | null> {
    // NOTE: keep this query control-plane-only. `apps` lives in the runtime
    // plane (moved out in runtime-plane migration 061) and joining it here
    // throws `relation "apps" does not exist`. Organization id is already on
    // org_app_index post-migration 090 — read it from there.
    const { rows } = await this.db.query<{ app_id: string; owner_id: string; organization_id: string | null }>(
      `SELECT kv.app_id,
              (SELECT o.owner_id FROM organizations o WHERE o.id = oai.organization_id) AS owner_id,
              oai.organization_id
         FROM app_kv_credentials kv
         JOIN org_app_index oai ON oai.app_id = kv.app_id
        WHERE kv.kv_function_key = $1 AND kv.app_id = $2`,
      [plaintextKey, appId],
    );
    return rows[0] ?? null;
  }

  async rotate(appId: string): Promise<KvCredential> {
    const password = randomBytes(KV_PASSWORD_BYTES).toString('hex');
    const { rows } = await this.db.query<KvCredential>(
      `UPDATE app_kv_credentials
       SET redis_password = $2, rotated_at = now()
       WHERE app_id = $1
       RETURNING *`,
      [appId, password],
    );
    if (rows.length === 0) throw new NotFoundError('KV credential', appId);
    return rows[0];
  }
}
