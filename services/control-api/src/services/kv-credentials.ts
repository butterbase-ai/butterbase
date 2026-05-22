import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';

const KV_PASSWORD_BYTES = 24;

export interface KvCredential {
  app_id: string;
  region: string;
  redis_password: string;
  created_at: Date;
  rotated_at: Date;
}

export class KvCredentialsService {
  constructor(private readonly pool: Pool) {}

  async provision(appId: string, region: string): Promise<KvCredential> {
    const password = randomBytes(KV_PASSWORD_BYTES).toString('hex');
    const { rows } = await this.pool.query<KvCredential>(
      `INSERT INTO app_kv_credentials (app_id, region, redis_password)
       VALUES ($1, $2, $3)
       ON CONFLICT (app_id) DO UPDATE SET region = EXCLUDED.region
       RETURNING *`,
      [appId, region, password],
    );
    return rows[0];
  }

  async lookup(appId: string): Promise<KvCredential | null> {
    const { rows } = await this.pool.query<KvCredential>(
      `SELECT * FROM app_kv_credentials WHERE app_id = $1`,
      [appId],
    );
    return rows[0] ?? null;
  }

  async rotate(appId: string): Promise<KvCredential> {
    const password = randomBytes(KV_PASSWORD_BYTES).toString('hex');
    const { rows } = await this.pool.query<KvCredential>(
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
