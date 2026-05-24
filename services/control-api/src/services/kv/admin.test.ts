/**
 * admin.test.ts — Unit/integration tests for appStats in admin.ts.
 *
 * Requires:
 *   KV_REDIS_URL_US=redis://:butterbase_dev_kv@localhost:6390
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { RedisClient } from './redis-client.js';
import { incBytes, resetCounter } from './storage-counter.js';
import { appStats } from './admin.js';
import type { KvLimits } from './limits.js';

const MOCK_LIMITS: KvLimits = {
  maxKeysTotal: 10000,
  maxStorageBytes: 104857600,
  maxOpsPerSec: 100,
  maxValueBytes: 102400,
};

const KV_REDIS_URL_US = process.env.KV_REDIS_URL_US ?? 'redis://:butterbase_dev_kv@localhost:6390';
const RUN_KV_TESTS = !!process.env.KV_REDIS_URL_US;
const describeKv = RUN_KV_TESTS ? describe : describe.skip;

function parseRedisUrl(url: string): { host: string; port: number; password: string } {
  const u = new URL(url);
  return { host: u.hostname, port: Number(u.port) || 6379, password: u.password };
}

let baseOpts: { host: string; port: number; password: string };
let metaClient: RedisClient;
let testAppId: string;

describeKv('appStats', () => {
  beforeAll(async () => {
    baseOpts = parseRedisUrl(KV_REDIS_URL_US);
    metaClient = await RedisClient.connect({ ...baseOpts, db: 0 });
  });

  afterAll(async () => {
    await metaClient.close();
  });

  beforeEach(async () => {
    testAppId = `admin-test-${randomUUID()}`;
    // Clean up any leftover state.
    await resetCounter(metaClient, testAppId);
    let cursor = '0';
    do {
      const [next, keys] = await metaClient.scan(cursor, `{${testAppId}}:u:*`, 100);
      if (keys.length > 0) await metaClient.del(keys);
      cursor = next;
    } while (cursor !== '0');
  });

  it('bytes_used comes from the running counter (O(1)) — not a scan estimate', async () => {
    // Set counter to a known value without writing any actual user keys.
    await incBytes(metaClient, testAppId, 12345);

    const stats = await appStats(baseOpts, testAppId, MOCK_LIMITS);

    expect(stats.bytes_used).toBe(12345);
    // No user keys were written so keys_total should be 0.
    expect(stats.keys_total).toBe(0);
  });

  it('bytes_used is 0 for a fresh app with no counter', async () => {
    const stats = await appStats(baseOpts, testAppId, MOCK_LIMITS);
    expect(stats.bytes_used).toBe(0);
  });

  it('keys_total reads from the keys counter (O(1)) — not a scan', async () => {
    // Set the keys counter directly to a known value.
    await metaClient.set(`{${testAppId}}:_meta:keys`, '5');

    const stats = await appStats(baseOpts, testAppId, MOCK_LIMITS);

    expect(stats.keys_total).toBe(5);
  });

  it('ops_per_sec reflects the current rate-limit bucket after a write', async () => {
    // Write a value into the current-second rate bucket.
    const bucket = Math.floor(Date.now() / 1000);
    const rateKey = `{${testAppId}}:_meta:rate:${bucket}`;
    await metaClient.set(rateKey, '7');

    const stats = await appStats(baseOpts, testAppId, MOCK_LIMITS);

    expect(stats.ops_per_sec).toBe(7);

    // Clean up.
    await metaClient.del([rateKey]);
  });

  it('ops_per_sec is 0 when no rate bucket exists', async () => {
    const stats = await appStats(baseOpts, testAppId, MOCK_LIMITS);
    expect(stats.ops_per_sec).toBe(0);
  });
});
