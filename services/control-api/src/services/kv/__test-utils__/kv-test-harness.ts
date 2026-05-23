/**
 * Shared test helpers for kv-data, kv-expose, and kv-admin route tests.
 *
 * Usage:
 *   import { buildAppWithDevKey, resetKvScope } from './__test-utils__/kv-test-harness.js';
 */

import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { KvCredentialsService } from '../../kv-credentials.js';
import { ApiKeyService } from '../../api-key-service.js';

export const PLATFORM_URL =
  process.env.NEON_PLATFORM_PRIMARY_URL ??
  'postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control';

export const KV_REDIS_URL_US =
  process.env.KV_REDIS_URL_US ?? 'redis://:butterbase_dev_kv@localhost:6390';

export const RUN_DB_TESTS = process.env.RUN_DB_TESTS === '1';

export interface AppFixture {
  pool: pg.Pool;
  svc: KvCredentialsService;
  appId: string;
  userId: string;
  devKey: string;
  region: string;
  redisPassword: string;
}

/**
 * Create a platform user + app + KV credentials + dev API key.
 * Returns the fixture so the caller can inject requests.
 */
export async function buildAppWithDevKey(pool: pg.Pool, label: string): Promise<AppFixture> {
  const svc = new KvCredentialsService(pool);

  // Upsert a test user.
  const r = await pool.query<{ id: string }>(
    `INSERT INTO platform_users (id, email, account_status, plan_id)
     VALUES ($1, $2, 'active', 'playground')
     ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id`,
    [randomUUID(), `${label}@kv-test.example.com`],
  );
  const userId = r.rows[0].id;

  // Create an app.
  const appId = `kv-test-${label.replace(/[^a-z0-9]/gi, '-')}-${Date.now()}`;
  await pool.query(
    `INSERT INTO apps (id, name, owner_id, db_name, region)
     VALUES ($1, $2, $3, $4, 'us')`,
    [appId, `KV Test ${appId}`, userId, `db_${appId}`],
  );

  // Provision KV credential.
  const cred = await svc.provision(appId, 'us');

  // Generate a dev API key.
  const { key: devKey } = await ApiKeyService.generateApiKey(pool, userId, `kv-test-key-${appId}`);

  return {
    pool,
    svc,
    appId,
    userId,
    devKey,
    region: cred.region,
    redisPassword: cred.redis_password,
  };
}

/**
 * Delete all KV data for an app from both Redis DBs (DB 0 + DB 1).
 * Removes user keys, TTL sidecars, and expose rules.
 */
export async function resetKvScope(appId: string): Promise<void> {
  const redis = new Redis(KV_REDIS_URL_US, { lazyConnect: false, maxRetriesPerRequest: 2 });
  try {
    const patterns = [
      `{${appId}}:u:*`,
      `{${appId}}:_ttl:*`,
      `{${appId}}:_meta:*`,
    ];
    for (const db of [0, 1]) {
      await redis.select(db);
      for (const pattern of patterns) {
        let cursor = '0';
        do {
          const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
          if (keys.length > 0) await redis.unlink(...keys);
          cursor = next;
        } while (cursor !== '0');
      }
    }
  } finally {
    await redis.quit();
  }
}

/**
 * Clean up test fixtures from the control DB.
 */
export async function cleanupFixture(pool: pg.Pool, appId: string): Promise<void> {
  await pool.query(`DELETE FROM api_keys WHERE name LIKE $1`, [`kv-test-key-${appId}%`]);
  await pool.query(`DELETE FROM app_kv_credentials WHERE app_id = $1`, [appId]);
  await pool.query(`DELETE FROM apps WHERE id = $1`, [appId]);
}
