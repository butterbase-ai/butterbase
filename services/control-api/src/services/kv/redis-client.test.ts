import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { RedisClient, wrap } from './redis-client.js';

const KV_REDIS_URL_US = process.env.KV_REDIS_URL_US ?? 'redis://:butterbase_dev_kv@localhost:6390';

const RUN_KV_TESTS = !!process.env.KV_REDIS_URL_US;
const describeKv = RUN_KV_TESTS ? describe : describe.skip;

let client: RedisClient;
let testKeyPrefix: string;

async function parseRedisUrl(url: string): Promise<{ host: string; port: number; password: string }> {
  const m = /^redis:\/\/:([^@]+)@([^:]+):(\d+)$/.exec(url);
  if (!m) throw new Error(`Invalid Redis URL: ${url}`);
  return {
    password: m[1],
    host: m[2],
    port: parseInt(m[3], 10),
  };
}

describeKv('RedisClient.dump/restore', () => {
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
    testKeyPrefix = `rc-test-${randomUUID()}`;
  });

  it('dump returns null for a missing key', async () => {
    const key = `{${testKeyPrefix}}:missing`;
    const result = await client.dump(key);
    expect(result).toBeNull();
  });

  it('dump+restore round-trips a string value', async () => {
    const srcKey = `{${testKeyPrefix}}:src`;
    const dstKey = `{${testKeyPrefix}}:dst`;

    // Set source key.
    await client.set(srcKey, 'hello');

    // Dump it.
    const payload = await client.dump(srcKey);
    expect(payload).not.toBeNull();
    expect(payload).toBeInstanceOf(Buffer);

    // Restore to destination key.
    await client.restore(dstKey, 0, payload!);

    // Verify destination key has the same value.
    const value = await client.get(dstKey);
    expect(value).toBe('hello');

    // Clean up.
    await client.del([srcKey, dstKey]);
  });

  it('restore with replace=true overwrites an existing key', async () => {
    const key = `{${testKeyPrefix}}:replace-test`;

    // Set initial value.
    await client.set(key, 'initial');

    // Dump a different value and restore with replace=true.
    const otherKey = `{${testKeyPrefix}}:other`;
    await client.set(otherKey, 'replacement');
    const payload = await client.dump(otherKey);
    expect(payload).not.toBeNull();

    // Restore with replace=true overwrites the existing key.
    await client.restore(key, 0, payload!, { replace: true });

    const value = await client.get(key);
    expect(value).toBe('replacement');

    // Clean up.
    await client.del([key, otherKey]);
  });

  it('restore rejects negative ttlMs', async () => {
    const key = `{${testKeyPrefix}}:negative-ttl`;
    const payload = Buffer.from('test');

    await expect(
      client.restore(key, -1, payload),
    ).rejects.toThrow(/negative ttlMs not allowed/);
  });

  it('restore preserves TTL', async () => {
    const srcKey = `{${testKeyPrefix}}:src-ttl`;
    const dstKey = `{${testKeyPrefix}}:dst-ttl`;

    // Set source key with expiration.
    await client.set(srcKey, 'value-with-ttl');
    await client.expire(srcKey, 100); // 100 seconds from now

    // Dump it.
    const payload = await client.dump(srcKey);
    expect(payload).not.toBeNull();

    // Restore with a 60-second TTL.
    await client.restore(dstKey, 60000, payload!); // 60000 milliseconds = 60 seconds

    // Verify TTL is set and is positive and <= 60.
    const ttl = await client.ttl(dstKey);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);

    // Clean up.
    await client.del([srcKey, dstKey]);
  });
});
