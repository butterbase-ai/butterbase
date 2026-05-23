import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { RedisClient } from './redis-client.js';
import { startKeysExpiryWorker, type KeysExpiryWorker } from './keys-expiry-worker.js';
import { incKeys, getKeys, resetKeysCounter } from './keys-counter.js';

const RUN_KV_TESTS = !!process.env.KV_REDIS_URL_US;
const describeKv = RUN_KV_TESTS ? describe : describe.skip;

describeKv('keys-expiry-worker', () => {
  let appId: string;
  let writer: Redis;
  let worker: KeysExpiryWorker;
  let counterClient: RedisClient;

  beforeEach(async () => {
    appId = `expiry-test-${randomUUID()}`;
    writer = new Redis(process.env.KV_REDIS_URL_US!);
    const u = new URL(process.env.KV_REDIS_URL_US!);
    counterClient = await RedisClient.connect({
      host: u.hostname,
      port: Number(u.port) || 6379,
      password: u.password ? decodeURIComponent(u.password) : '',
      db: 0,
    });
    await incKeys(counterClient, appId, 2);
    const [, val] = await writer.config('GET', 'notify-keyspace-events') as [string, string];
    if (!val || !val.includes('E') || !val.includes('x')) {
      throw new Error('Test prereq: redis must have notify-keyspace-events Ex set');
    }
    worker = startKeysExpiryWorker({
      regions: ['us-test'],
      urlForRegion: () => process.env.KV_REDIS_URL_US!,
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });
    await new Promise((r) => setTimeout(r, 200));
  });

  afterEach(async () => {
    await worker.stop();
    await resetKeysCounter(counterClient, appId);
    await counterClient.close();
    await writer.quit();
  });

  it('decrements the counter when a user key expires', async () => {
    await writer.set(`{${appId}}:u:ephemeral`, 'v', 'PX', 200);
    await new Promise((r) => setTimeout(r, 800));
    expect(await getKeys(counterClient, appId)).toBe(1);
  });

  it('ignores non-user-key expiries (_meta:rate:* etc.)', async () => {
    await writer.set(`{${appId}}:_meta:rate:9999`, '5', 'PX', 200);
    await new Promise((r) => setTimeout(r, 800));
    expect(await getKeys(counterClient, appId)).toBe(2);
  });
});
