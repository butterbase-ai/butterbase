// test/redis-client.test.ts
// Requires kv-redis-1 container running on localhost:6390, password butterbase_dev_kv.
import { describe, it, expect, beforeEach } from 'vitest';
import { RedisClient } from '../src/redis-client.js';

const HOST = process.env.KV_REDIS_HOST ?? 'localhost';
const PORT = Number(process.env.KV_REDIS_PORT ?? 6390);
const PASS = process.env.KV_REDIS_PASS ?? 'butterbase_dev_kv';

describe('RedisClient (integration)', () => {
  beforeEach(async () => {
    const c = await RedisClient.connect({ host: HOST, port: PORT, password: PASS, db: 15 });
    await c.flushTestDb();
    await c.close();
  });

  it('set + get round-trips bytes', async () => {
    const c = await RedisClient.connect({ host: HOST, port: PORT, password: PASS, db: 15 });
    await c.set('foo', 'bar');
    expect(await c.get('foo')).toBe('bar');
    await c.close();
  });

  it('get on missing returns null', async () => {
    const c = await RedisClient.connect({ host: HOST, port: PORT, password: PASS, db: 15 });
    expect(await c.get('missing')).toBeNull();
    await c.close();
  });

  it('del returns count', async () => {
    const c = await RedisClient.connect({ host: HOST, port: PORT, password: PASS, db: 15 });
    await c.set('a', '1');
    expect(await c.del(['a', 'missing'])).toBe(1);
    await c.close();
  });

  it('wrong password rejects', async () => {
    await expect(
      RedisClient.connect({ host: HOST, port: PORT, password: 'wrong', db: 15 }),
    ).rejects.toThrow(/AUTH/i);
  });
});
