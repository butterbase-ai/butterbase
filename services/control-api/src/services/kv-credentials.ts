import { randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

const KV_PASSWORD_BYTES = 24;

export interface KvCredential {
  app_id: string;
  region: string;
  redis_password: string;
  created_at: Date;
  rotated_at: Date;
}

type Queryable = Pool | PoolClient;

export class KvCredentialsService {
  constructor(private readonly db: Queryable) {}

  async provision(appId: string, region: string): Promise<KvCredential> {
    const password = randomBytes(KV_PASSWORD_BYTES).toString('hex');
    const ins = await this.db.query<KvCredential>(
      `INSERT INTO app_kv_credentials (app_id, region, redis_password)
       VALUES ($1, $2, $3)
       ON CONFLICT (app_id) DO NOTHING
       RETURNING *`,
      [appId, region, password],
    );
    if (ins.rows.length > 0) return ins.rows[0];
    // Conflict — credential already exists; return the existing row unchanged.
    // The newly-generated `password` is intentionally discarded so the Redis password
    // stays stable across retried provisioning attempts. To change the password, use `rotate()`.
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

  async rotate(appId: string): Promise<KvCredential> {
    const password = randomBytes(KV_PASSWORD_BYTES).toString('hex');
    const { rows } = await this.db.query<KvCredential>(
      `UPDATE app_kv_credentials
       SET redis_password = $2, rotated_at = now()
       WHERE app_id = $1
       RETURNING *`,
      [appId, password],
    );
    if (rows.length === 0) throw new Error(`No KV credential for app ${appId}`);
    return rows[0];
  }
}
