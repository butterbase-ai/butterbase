import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { RedisClient } from './redis-client.js';
import { checkRateLimit } from './rate-limit.js';

const KV_REDIS_URL_US = process.env.KV_REDIS_URL_US ?? 'redis://:butterbase_dev_kv@localhost:6390';

const RUN_KV_TESTS = !!process.env.KV_REDIS_URL_US;
const describeKv = RUN_KV_TESTS ? describe : describe.skip;

let client: RedisClient;
let testAppId: string;

async function parseRedisUrl(url: string): Promise<{ host: string; port: number; password: string }> {
  const m = /^redis:\/\/:([^@]+)@([^:]+):(\d+)$/.exec(url);
  if (!m) throw new Error(`Invalid Redis URL: ${url}`);
  return {
    password: m[1],
    host: m[2],
    port: parseInt(m[3], 10),
  };
}

describeKv('rate-limit', () => {
  beforeAll(async () => {
    if (!RUN_KV_TESTS) return;
    const redisOpts = await parseRedisUrl(KV_REDIS_URL_US);
    client = await RedisClient.connect({ ...redisOpts, db: 0 });
  });

  afterAll(async () => {
    if (!RUN_KV_TESTS) return;
    await client.close();
  });

  beforeEach(async () => {
    if (!RUN_KV_TESTS) return;
    testAppId = `rate-limit-test-${randomUUID()}`;
    // Clean up rate limit keys for this test app
    let cursor = '0';
    do {
      const [next, keys] = await client.scan(cursor, `{${testAppId}}:_meta:rate:*`, 100);
      if (keys.length > 0) {
        await client.del(keys);
      }
      cursor = next;
    } while (cursor !== '0');
  });

  it('below limit returns allowed true', async () => {
    const result = await checkRateLimit(client, testAppId, 10, 50);
    expect(result).toEqual({ allowed: true });
  });

  it('exactly at limit returns allowed true', async () => {
    const result = await checkRateLimit(client, testAppId, 50, 50);
    expect(result).toEqual({ allowed: true });
  });

  it('over limit returns allowed false', async () => {
    // First call uses 50, second call with 1 more should exceed
    await checkRateLimit(client, testAppId, 50, 50);
    const result = await checkRateLimit(client, testAppId, 1, 50);
    expect(result).toEqual({ allowed: false, retryAfterSec: 1 });
  });

  it('batch cost is applied in a single call', async () => {
    const result = await checkRateLimit(client, testAppId, 25, 50);
    expect(result).toEqual({ allowed: true });
  });

  it('new bucket allows requests again after 1 second', async () => {
    // Hit the limit in the first second
    await checkRateLimit(client, testAppId, 50, 50);
    const resultFirst = await checkRateLimit(client, testAppId, 1, 50);
    expect(resultFirst).toEqual({ allowed: false, retryAfterSec: 1 });

    // Wait for the next second
    await new Promise(r => setTimeout(r, 1100));

    // Request in the new bucket should be allowed
    const resultSecond = await checkRateLimit(client, testAppId, 10, 50);
    expect(resultSecond).toEqual({ allowed: true });
  });

  it('TTL is set on first hit', async () => {
    await checkRateLimit(client, testAppId, 10, 50);
    const bucket = Math.floor(Date.now() / 1000);
    const key = `{${testAppId}}:_meta:rate:${bucket}`;

    const ttl = await client.ttl(key);
    // TTL should be set and in the range (0, 2]
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(2);
  });
});
