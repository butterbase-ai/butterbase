import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { RedisClient } from './redis-client.js';
import { incKeys, decKeys, getKeys, resetKeysCounter } from './keys-counter.js';

const RUN_KV_TESTS = !!process.env.KV_REDIS_URL_US;
const describeKv = RUN_KV_TESTS ? describe : describe.skip;

function baseOptsFromEnv() {
  const u = new URL(process.env.KV_REDIS_URL_US!);
  return {
    host: u.hostname,
    port: Number(u.port) || 6379,
    password: u.password ? decodeURIComponent(u.password) : '',
  };
}

describeKv('keys-counter', () => {
  let client: RedisClient;
  let appId: string;

  beforeEach(async () => {
    appId = `keys-counter-test-${randomUUID()}`;
    client = await RedisClient.connect({ ...baseOptsFromEnv(), db: 0 });
  });

  afterEach(async () => {
    await resetKeysCounter(client, appId);
    await client.close();
  });

  it('getKeys returns 0 when the counter is absent', async () => {
    expect(await getKeys(client, appId)).toBe(0);
  });

  it('incKeys increments and returns the new value', async () => {
    expect(await incKeys(client, appId, 3)).toBe(3);
    expect(await incKeys(client, appId, 2)).toBe(5);
    expect(await getKeys(client, appId)).toBe(5);
  });

  it('decKeys decrements and clamps the input but allows negative results', async () => {
    await incKeys(client, appId, 5);
    expect(await decKeys(client, appId, 2)).toBe(3);
    expect(await decKeys(client, appId, 10)).toBe(-7);
    expect(await getKeys(client, appId)).toBe(-7);
  });

  it('incKeys clamps a negative delta to 0 (defensive)', async () => {
    expect(await incKeys(client, appId, -5)).toBe(0);
    expect(await getKeys(client, appId)).toBe(0);
  });

  it('decKeys clamps a negative delta to 0 (defensive)', async () => {
    await incKeys(client, appId, 3);
    expect(await decKeys(client, appId, -5)).toBe(3);
    expect(await getKeys(client, appId)).toBe(3);
  });

  it('resetKeysCounter deletes the counter', async () => {
    await incKeys(client, appId, 7);
    await resetKeysCounter(client, appId);
    expect(await getKeys(client, appId)).toBe(0);
  });
});
