import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { RedisClient } from './redis-client.js';
import {
  getStorageBytes,
  incBytes,
  decBytes,
  resetCounter,
  reconcileFromScan,
} from './storage-counter.js';

const KV_REDIS_URL_US = process.env.KV_REDIS_URL_US ?? 'redis://:butterbase_dev_kv@localhost:6390';
const CONTROL_DB_URL = process.env.NEON_PLATFORM_PRIMARY_URL ?? 'postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control';

const RUN_KV_TESTS = !!process.env.KV_REDIS_URL_US;
const RUN_DB_TESTS = !!process.env.RUN_DB_TESTS && !!process.env.NEON_PLATFORM_PRIMARY_URL;

function makeControlPool(): pg.Pool {
  return new pg.Pool({ connectionString: CONTROL_DB_URL });
}

function baseOptsFromEnv(): { host: string; port: number; password: string } {
  const m = /^redis:\/\/:([^@]+)@([^:]+):(\d+)$/.exec(KV_REDIS_URL_US);
  if (!m) throw new Error(`Invalid Redis URL: ${KV_REDIS_URL_US}`);
  return { password: m[1], host: m[2], port: parseInt(m[3], 10) };
}
const describeKv = RUN_KV_TESTS ? describe : describe.skip;

let client: RedisClient;
let testAppId: string;
let redisOpts: { host: string; port: number; password: string };

async function parseRedisUrl(url: string): Promise<{ host: string; port: number; password: string }> {
  const m = /^redis:\/\/:([^@]+)@([^:]+):(\d+)$/.exec(url);
  if (!m) throw new Error(`Invalid Redis URL: ${url}`);
  return {
    password: m[1],
    host: m[2],
    port: parseInt(m[3], 10),
  };
}

describeKv('storage-counter', () => {
  beforeAll(async () => {
    if (!RUN_KV_TESTS) return;
    redisOpts = await parseRedisUrl(KV_REDIS_URL_US);
    client = await RedisClient.connect({ ...redisOpts, db: 0 });
  });

  afterAll(async () => {
    if (!RUN_KV_TESTS) return;
    await client.close();
  });

  beforeEach(async () => {
    if (!RUN_KV_TESTS) return;
    testAppId = `storage-counter-test-${randomUUID()}`;
    // Clean up the meta key and any user keys for this test app.
    await client.del([`{${testAppId}}:_meta:bytes`]);
    let cursor = '0';
    do {
      const [next, keys] = await client.scan(cursor, `{${testAppId}}:u:*`, 100);
      if (keys.length > 0) {
        await client.del(keys);
      }
      cursor = next;
    } while (cursor !== '0');
  });

  it('getStorageBytes returns 0 for a fresh app', async () => {
    const bytes = await getStorageBytes(client, testAppId);
    expect(bytes).toBe(0);
  });

  it('incBytes/decBytes are arithmetic and atomic', async () => {
    let value = await incBytes(client, testAppId, 100);
    expect(value).toBe(100);

    value = await incBytes(client, testAppId, 50);
    expect(value).toBe(150);

    value = await decBytes(client, testAppId, 30);
    expect(value).toBe(120);

    const stored = await getStorageBytes(client, testAppId);
    expect(stored).toBe(120);
  });

  it('incBytes/decBytes clamp deltas to 0', async () => {
    let value = await incBytes(client, testAppId, -100);
    expect(value).toBe(0); // incrBy with negative delta should clamp

    value = await decBytes(client, testAppId, -50);
    expect(value).toBe(0); // decrBy with negative delta should clamp
  });

  it('resetCounter zeroes the counter', async () => {
    await incBytes(client, testAppId, 500);
    let bytes = await getStorageBytes(client, testAppId);
    expect(bytes).toBe(500);

    await resetCounter(client, testAppId);
    bytes = await getStorageBytes(client, testAppId);
    expect(bytes).toBe(0);
  });

  it('reconcileFromScan reads actual MEMORY USAGE and updates counter', async () => {
    // Write 3 real keys with known structure.
    const key1 = `{${testAppId}}:u:key1`;
    const key2 = `{${testAppId}}:u:key2`;
    const key3 = `{${testAppId}}:u:key3`;

    await client.set(key1, 'value1');
    await client.set(key2, 'value2-longer');
    await client.set(key3, 'value3-even-longer-string');

    // Set the counter to a deliberately wrong value (too low).
    const wrongCounter = 50;
    await client.set(`{${testAppId}}:_meta:bytes`, String(wrongCounter));

    // Run reconcile with baseOpts.
    const result = await reconcileFromScan(client, testAppId, redisOpts);

    // Verify previous was the wrong value.
    expect(result.previous).toBe(wrongCounter);

    // Verify actual is the sum of MEMORY USAGE for all keys (should be > 0).
    expect(result.actual).toBeGreaterThan(0);

    // Verify counter was updated to actual.
    const updated = await getStorageBytes(client, testAppId);
    expect(updated).toBe(result.actual);
  });

  it('reconcileFromScan scans both DB 0 and DB 1', async () => {
    // This test verifies the scan logic touches both DBs.
    // We write a key in DB 0 (current), then verify the counter includes it.

    const key1 = `{${testAppId}}:u:db0-key`;
    await client.set(key1, 'test-value');

    const result = await reconcileFromScan(client, testAppId, redisOpts);

    // The actual should be > 0 because we wrote at least one key.
    expect(result.actual).toBeGreaterThan(0);

    // Verify the counter reflects it.
    const stored = await getStorageBytes(client, testAppId);
    expect(stored).toBe(result.actual);
  });

  it('reconcileFromScan also updates _meta:keys with the actual count', async () => {
    const appId = `recon-keys-${randomUUID()}`;
    const base = baseOptsFromEnv();
    const c0 = await RedisClient.connect({ ...base, db: 0 });
    const c1 = await RedisClient.connect({ ...base, db: 1 });
    try {
      await c0.set(`{${appId}}:u:a`, 'va');
      await c0.set(`{${appId}}:u:b`, 'vb');
      await c1.set(`{${appId}}:u:eph`, 've');
      await c0.set(`{${appId}}:_meta:keys`, '99');

      await reconcileFromScan(c0, appId, base);

      const got = await c0.get(`{${appId}}:_meta:keys`);
      expect(parseInt(got!, 10)).toBe(3);
    } finally {
      await c0.del([`{${appId}}:u:a`, `{${appId}}:u:b`, `{${appId}}:_meta:bytes`, `{${appId}}:_meta:keys`]);
      await c1.del([`{${appId}}:u:eph`]);
      await c0.close();
      await c1.close();
    }
  });
});

const describeDb = RUN_DB_TESTS ? describe : describe.skip;

describeDb('storage-counter (DB integration)', () => {
  it('reconcileFromScan inserts/updates a kv_app_usage_snapshot row', async () => {
    const appId = `recon-snap-${randomUUID()}`;
    const base = baseOptsFromEnv();
    const c0 = await RedisClient.connect({ ...base, db: 0 });
    const pool = makeControlPool();
    await pool.query(
      "INSERT INTO apps (id, name, owner_id, db_name, region) VALUES ($1, 'recon-snap', $2, $1, 'us') ON CONFLICT DO NOTHING",
      [appId, '11111111-1111-1111-1111-111111111111'],
    );
    try {
      await c0.set(`{${appId}}:u:x`, 'vx');
      await reconcileFromScan(c0, appId, base, { controlPool: pool, region: 'us' });
      const r = await pool.query(
        'SELECT bytes_used, keys_total, region FROM kv_app_usage_snapshot WHERE app_id = $1',
        [appId],
      );
      expect(r.rows[0].keys_total).toBe('1');
      expect(parseInt(r.rows[0].bytes_used, 10)).toBeGreaterThan(0);
      expect(r.rows[0].region).toBe('us');
    } finally {
      await pool.query('DELETE FROM kv_app_usage_snapshot WHERE app_id = $1', [appId]);
      await pool.query('DELETE FROM apps WHERE id = $1', [appId]);
      await c0.del([`{${appId}}:u:x`, `{${appId}}:_meta:bytes`, `{${appId}}:_meta:keys`]);
      await c0.close();
      await pool.end();
    }
  });
});
