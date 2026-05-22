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

  it('setex sets a value and ttl returns remaining seconds', async () => {
    const c = await RedisClient.connect({ host: HOST, port: PORT, password: PASS, db: 15 });
    const ttlSeconds = 30;
    await c.setex('mykey', ttlSeconds, 'hello');
    expect(await c.get('mykey')).toBe('hello');
    const remaining = await c.ttl('mykey');
    expect(remaining).toBeGreaterThanOrEqual(1);
    expect(remaining).toBeLessThanOrEqual(ttlSeconds);
    await c.close();
  });

  it('setnx returns true first time and false second time; value unchanged', async () => {
    const c = await RedisClient.connect({ host: HOST, port: PORT, password: PASS, db: 15 });
    const wrote1 = await c.setnx('nx-key', 'original');
    expect(wrote1).toBe(true);
    const wrote2 = await c.setnx('nx-key', 'overwrite');
    expect(wrote2).toBe(false);
    expect(await c.get('nx-key')).toBe('original');
    await c.close();
  });

  it('incrBy increments by given amount on new and existing key', async () => {
    const c = await RedisClient.connect({ host: HOST, port: PORT, password: PASS, db: 15 });
    const first = await c.incrBy('counter', 5);
    expect(first).toBe(5);
    const second = await c.incrBy('counter', 5);
    expect(second).toBe(10);
    await c.close();
  });

  it('decrBy decrements by given amount', async () => {
    const c = await RedisClient.connect({ host: HOST, port: PORT, password: PASS, db: 15 });
    await c.set('counter', '20');
    const first = await c.decrBy('counter', 7);
    expect(first).toBe(13);
    const second = await c.decrBy('counter', 3);
    expect(second).toBe(10);
    await c.close();
  });

  it('exists returns true for present key and false for missing key', async () => {
    const c = await RedisClient.connect({ host: HOST, port: PORT, password: PASS, db: 15 });
    await c.set('present', 'yes');
    expect(await c.exists('present')).toBe(true);
    expect(await c.exists('missing-key')).toBe(false);
    await c.close();
  });

  it('expire(key, n) returns true on existing key, false on missing', async () => {
    const c = await RedisClient.connect({ host: HOST, port: PORT, password: PASS, db: 15 });
    await c.set('exp-key', 'val');
    expect(await c.expire('exp-key', 60)).toBe(true);
    expect(await c.expire('no-such-key', 60)).toBe(false);
    await c.close();
  });

  it('expire(key, null) clears TTL — ttl returns -1 after PERSIST', async () => {
    const c = await RedisClient.connect({ host: HOST, port: PORT, password: PASS, db: 15 });
    await c.setex('persist-key', 60, 'val');
    const before = await c.ttl('persist-key');
    expect(before).toBeGreaterThan(0);
    await c.expire('persist-key', null);
    expect(await c.ttl('persist-key')).toBe(-1);
    await c.close();
  });

  it('mget returns values in order; missing keys map to null', async () => {
    const c = await RedisClient.connect({ host: HOST, port: PORT, password: PASS, db: 15 });
    await c.set('a', '1');
    const results = await c.mget(['a', 'b', 'c']);
    expect(results).toEqual(['1', null, null]);
    await c.close();
  });

  it('mset followed by mget returns matching values', async () => {
    const c = await RedisClient.connect({ host: HOST, port: PORT, password: PASS, db: 15 });
    await c.mset([['x', 'foo'], ['y', 'bar'], ['z', 'baz']]);
    const results = await c.mget(['x', 'y', 'z']);
    expect(results).toEqual(['foo', 'bar', 'baz']);
    await c.close();
  });

  it('eval executes a Lua script and returns result', async () => {
    const c = await RedisClient.connect({ host: HOST, port: PORT, password: PASS, db: 15 });
    const result = await c.eval('return ARGV[1]', [], ['hello-from-lua']);
    expect(result).toBe('hello-from-lua');
    await c.close();
  });

  it('setWithOptions with NX returns true first time and false second time; value unchanged', async () => {
    const c = await RedisClient.connect({ host: HOST, port: PORT, password: PASS, db: 15 });
    const first = await c.setWithOptions('opts-key', 'original', { ex: 60, nx: true });
    expect(first).toBe(true);
    const second = await c.setWithOptions('opts-key', 'overwrite', { ex: 60, nx: true });
    expect(second).toBe(false);
    expect(await c.get('opts-key')).toBe('original');
    await c.close();
  });

  it('setWithOptions with XX updates existing but not missing', async () => {
    const c = await RedisClient.connect({ host: HOST, port: PORT, password: PASS, db: 15 });
    const missingResult = await c.setWithOptions('xx-missing', 'v', { xx: true });
    expect(missingResult).toBe(false);
    await c.set('xx-existing', 'old');
    const existResult = await c.setWithOptions('xx-existing', 'new', { xx: true });
    expect(existResult).toBe(true);
    expect(await c.get('xx-existing')).toBe('new');
    await c.close();
  });
});
