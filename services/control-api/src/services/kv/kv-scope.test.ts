import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { RedisClient } from './redis-client.js';
import { clearKvScope } from './kv-scope.js';

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

describeKv('clearKvScope', () => {
  const appId = `scope-test-${randomUUID()}`;
  const base = baseOptsFromEnv();

  beforeEach(async () => {
    const c0 = await RedisClient.connect({ ...base, db: 0 });
    const c1 = await RedisClient.connect({ ...base, db: 1 });
    try {
      await c0.set(`{${appId}}:u:a`, 'va');
      await c0.set(`{${appId}}:u:b`, 'vb');
      await c0.set(`{${appId}}:_meta:bytes`, '42');
      await c1.set(`{${appId}}:u:eph`, 've');
    } finally {
      await c0.close();
      await c1.close();
    }
  });

  afterEach(async () => {
    // Defensive cleanup if a test threw before clearing.
    const c0 = await RedisClient.connect({ ...base, db: 0 });
    const c1 = await RedisClient.connect({ ...base, db: 1 });
    try {
      let cur = '0';
      do {
        const [next, ks] = await c0.scan(cur, `{${appId}}:*`, 500);
        cur = next;
        if (ks.length) await c0.del(ks);
      } while (cur !== '0');
      cur = '0';
      do {
        const [next, ks] = await c1.scan(cur, `{${appId}}:*`, 500);
        cur = next;
        if (ks.length) await c1.del(ks);
      } while (cur !== '0');
    } finally {
      await c0.close();
      await c1.close();
    }
  });

  it('deletes all {appId}:* keys across both DBs and returns the count', async () => {
    const count = await clearKvScope('us-east-1', appId, base);
    expect(count).toBe(4);

    // Verify scope is empty
    const c0 = await RedisClient.connect({ ...base, db: 0 });
    const c1 = await RedisClient.connect({ ...base, db: 1 });
    try {
      const [, k0] = await c0.scan('0', `{${appId}}:*`, 500);
      const [, k1] = await c1.scan('0', `{${appId}}:*`, 500);
      expect(k0).toEqual([]);
      expect(k1).toEqual([]);
    } finally {
      await c0.close();
      await c1.close();
    }
  });

  it('returns 0 when the scope has no keys', async () => {
    const emptyAppId = `empty-scope-${randomUUID()}`;
    const count = await clearKvScope('us-east-1', emptyAppId, base);
    expect(count).toBe(0);
  });
});
