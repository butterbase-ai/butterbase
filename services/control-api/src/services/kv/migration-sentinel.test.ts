import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { RedisClient } from './redis-client.js';
import { setKvBlock, clearKvBlock, isKvBlocked } from './migration-sentinel.js';

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

describeKv('migration-sentinel', () => {
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
    testAppId = `sentinel-test-${randomUUID()}`;
    // Clean up the migration sentinel key for this test app.
    await client.del([`{${testAppId}}:_meta:migration`]);
  });

  it('starts unblocked (no key set)', async () => {
    const blocked = await isKvBlocked(client, testAppId);
    expect(blocked).toBe(false);
  });

  it('setKvBlock then isKvBlocked returns true; clearKvBlock makes it false', async () => {
    // Initially unblocked.
    let blocked = await isKvBlocked(client, testAppId);
    expect(blocked).toBe(false);

    // Set the block.
    await setKvBlock(client, testAppId);
    blocked = await isKvBlocked(client, testAppId);
    expect(blocked).toBe(true);

    // Clear the block.
    await clearKvBlock(client, testAppId);
    blocked = await isKvBlocked(client, testAppId);
    expect(blocked).toBe(false);
  });

  it('setKvBlock sets a TTL (1h)', async () => {
    await setKvBlock(client, testAppId);

    const ttl = await client.ttl(`{${testAppId}}:_meta:migration`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(3600);
  });
});
