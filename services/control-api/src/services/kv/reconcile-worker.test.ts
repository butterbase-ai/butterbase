/**
 * reconcile-worker.test.ts — Tests for the daily KV reconcile worker.
 *
 * Requires:
 *   KV_REDIS_URL_US=redis://:butterbase_dev_kv@localhost:6390
 *
 * Does NOT require RUN_DB_TESTS because we mock the controlDb pool.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { RedisClient } from './redis-client.js';
import { getStorageBytes, resetCounter } from './storage-counter.js';
import { runReconcileTick } from './reconcile-worker.js';

const KV_REDIS_URL_US = process.env.KV_REDIS_URL_US ?? 'redis://:butterbase_dev_kv@localhost:6390';
const RUN_KV_TESTS = !!process.env.KV_REDIS_URL_US;
const describeKv = RUN_KV_TESTS ? describe : describe.skip;

function parseRedisUrl(url: string): { host: string; port: number; password: string } {
  const u = new URL(url);
  return { host: u.hostname, port: Number(u.port) || 6379, password: u.password };
}

describeKv('startKvReconcileWorker', () => {
  let client: RedisClient;
  let testAppId: string;
  let baseOpts: { host: string; port: number; password: string };

  beforeAll(async () => {
    baseOpts = parseRedisUrl(KV_REDIS_URL_US);
    client = await RedisClient.connect({ ...baseOpts, db: 0 });
    // Set the env var so the worker can look it up.
    process.env.KV_REDIS_URL_US = KV_REDIS_URL_US;
  });

  afterAll(async () => {
    await client.close();
  });

  beforeEach(async () => {
    testAppId = `reconcile-test-${randomUUID()}`;
    // Clean up meta key and user keys.
    await resetCounter(client, testAppId);
    let cursor = '0';
    do {
      const [next, keys] = await client.scan(cursor, `{${testAppId}}:u:*`, 100);
      if (keys.length > 0) await client.del(keys);
      cursor = next;
    } while (cursor !== '0');
  });

  it('reconcile tick corrects a wrong counter to match actual MEMORY USAGE', async () => {
    // Write 3 user keys.
    await client.set(`{${testAppId}}:u:k1`, 'value1');
    await client.set(`{${testAppId}}:u:k2`, 'value2-longer');
    await client.set(`{${testAppId}}:u:k3`, 'value3-even-longer-string');

    // Set the counter to a deliberately wrong value.
    await client.set(`{${testAppId}}:_meta:bytes`, '9999999');

    // Build a mock controlDb that returns one row for our test app.
    const mockControlDb = {
      query: vi.fn().mockResolvedValue({
        rows: [{ app_id: testAppId, region: 'us', redis_password: baseOpts.password }],
      }),
    } as any;

    // Drive the worker tick directly — avoids fake-timer interval loops.
    await runReconcileTick(mockControlDb);

    // Counter should now match the actual MEMORY USAGE sum (> 0, not 9999999).
    const updated = await getStorageBytes(client, testAppId);
    expect(updated).toBeGreaterThan(0);
    expect(updated).not.toBe(9999999);

    // controlDb.query is called twice: once for the SELECT in runReconcileTick,
    // and once for the snapshot INSERT inside reconcileFromScan.
    expect(mockControlDb.query).toHaveBeenCalledTimes(2);
  });
});
