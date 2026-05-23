// test/redis-client.test.ts
// Requires kv-redis-1 container running on localhost:6390, password butterbase_dev_kv.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RedisClient } from '../src/redis-client.js';

const HOST = process.env.KV_REDIS_HOST ?? 'localhost';
const PORT = Number(process.env.KV_REDIS_PORT ?? 6390);
const PASS = process.env.KV_REDIS_PASS ?? 'butterbase_dev_kv';

describe('RedisClient (integration)', () => {
  let c: RedisClient | null = null;

  beforeEach(async () => {
    c = await RedisClient.connect({ host: HOST, port: PORT, password: PASS, db: 15 });
    try {
      await c.flushTestDb();
    } finally {
      await c.close();
      c = null;
    }
  });

  afterEach(async () => {
    if (c) {
      await c.close();
      c = null;
    }
  });

  it('set + get round-trips bytes', async () => {
    c = await RedisClient.connect({ host: HOST, port: PORT, password: PASS, db: 15 });
    await c.set('foo', 'bar');
    expect(await c.get('foo')).toBe('bar');
  });

  it('get on missing returns null', async () => {
    c = await RedisClient.connect({ host: HOST, port: PORT, password: PASS, db: 15 });
    expect(await c.get('missing')).toBeNull();
  });

  it('del returns count', async () => {
    c = await RedisClient.connect({ host: HOST, port: PORT, password: PASS, db: 15 });
    await c.set('a', '1');
    expect(await c.del(['a', 'missing'])).toBe(1);
  });

  it('wrong password rejects', async () => {
    await expect(
      RedisClient.connect({ host: HOST, port: PORT, password: 'wrong', db: 15 }),
    ).rejects.toThrow(/AUTH/i);
  });

  it('setex sets a value and ttl returns remaining seconds', async () => {
    c = await RedisClient.connect({ host: HOST, port: PORT, password: PASS, db: 15 });
    const ttlSeconds = 30;
    await c.setex('mykey', ttlSeconds, 'hello');
    expect(await c.get('mykey')).toBe('hello');
    const remaining = await c.ttl('mykey');
    expect(remaining).toBeGreaterThanOrEqual(1);
    expect(remaining).toBeLessThanOrEqual(ttlSeconds);
  });

  it('setnx returns true first time and false second time; value unchanged', async () => {
    c = await RedisClient.connect({ host: HOST, port: PORT, password: PASS, db: 15 });
    const wrote1 = await c.setnx('nx-key', 'original');
    expect(wrote1).toBe(true);
    const wrote2 = await c.setnx('nx-key', 'overwrite');
    expect(wrote2).toBe(false);
    expect(await c.get('nx-key')).toBe('original');
  });

  it('incrBy increments by given amount on new and existing key', async () => {
    c = await RedisClient.connect({ host: HOST, port: PORT, password: PASS, db: 15 });
    const first = await c.incrBy('counter', 5);
    expect(first).toBe(5);
    const second = await c.incrBy('counter', 5);
    expect(second).toBe(10);
  });

  it('decrBy decrements by given amount', async () => {
    c = await RedisClient.connect({ host: HOST, port: PORT, password: PASS, db: 15 });
    await c.set('counter', '20');
    const first = await c.decrBy('counter', 7);
    expect(first).toBe(13);
    const second = await c.decrBy('counter', 3);
    expect(second).toBe(10);
  });

  it('exists returns true for present key and false for missing key', async () => {
    c = await RedisClient.connect({ host: HOST, port: PORT, password: PASS, db: 15 });
    await c.set('present', 'yes');
    expect(await c.exists('present')).toBe(true);
    expect(await c.exists('missing-key')).toBe(false);
  });

  it('expire(key, n) returns true on existing key, false on missing', async () => {
    c = await RedisClient.connect({ host: HOST, port: PORT, password: PASS, db: 15 });
    await c.set('exp-key', 'val');
    expect(await c.expire('exp-key', 60)).toBe(true);
    expect(await c.expire('no-such-key', 60)).toBe(false);
  });

  it('expire(key, null) clears TTL — ttl returns -1 after PERSIST', async () => {
    c = await RedisClient.connect({ host: HOST, port: PORT, password: PASS, db: 15 });
    await c.setex('persist-key', 60, 'val');
    const before = await c.ttl('persist-key');
    expect(before).toBeGreaterThan(0);
    await c.expire('persist-key', null);
    expect(await c.ttl('persist-key')).toBe(-1);
  });

  it('mget returns values in order; missing keys map to null', async () => {
    c = await RedisClient.connect({ host: HOST, port: PORT, password: PASS, db: 15 });
    await c.set('a', '1');
    const results = await c.mget(['a', 'b', 'c']);
    expect(results).toEqual(['1', null, null]);
  });

  it('mset followed by mget returns matching values', async () => {
    c = await RedisClient.connect({ host: HOST, port: PORT, password: PASS, db: 15 });
    await c.mset([['x', 'foo'], ['y', 'bar'], ['z', 'baz']]);
    const results = await c.mget(['x', 'y', 'z']);
    expect(results).toEqual(['foo', 'bar', 'baz']);
  });

  it('eval executes a Lua script and returns result', async () => {
    c = await RedisClient.connect({ host: HOST, port: PORT, password: PASS, db: 15 });
    const result = await c.eval('return ARGV[1]', [], ['hello-from-lua']);
    expect(result).toBe('hello-from-lua');
  });

  it('setWithOptions with NX returns true first time and false second time; value unchanged', async () => {
    c = await RedisClient.connect({ host: HOST, port: PORT, password: PASS, db: 15 });
    const first = await c.setWithOptions('opts-key', 'original', { ex: 60, nx: true });
    expect(first).toBe(true);
    const second = await c.setWithOptions('opts-key', 'overwrite', { ex: 60, nx: true });
    expect(second).toBe(false);
    expect(await c.get('opts-key')).toBe('original');
  });

  it('setWithOptions with XX updates existing but not missing', async () => {
    c = await RedisClient.connect({ host: HOST, port: PORT, password: PASS, db: 15 });
    const missingResult = await c.setWithOptions('xx-missing', 'v', { xx: true });
    expect(missingResult).toBe(false);
    await c.set('xx-existing', 'old');
    const existResult = await c.setWithOptions('xx-existing', 'new', { xx: true });
    expect(existResult).toBe(true);
    expect(await c.get('xx-existing')).toBe('new');
  });

  it('hset + hgetall round-trips hash fields', async () => {
    c = await RedisClient.connect({ host: HOST, port: PORT, password: PASS, db: 15 });
    await c.hset('myhash', 'field1', 'value1');
    await c.hset('myhash', 'field2', 'value2');
    const result = await c.hgetall('myhash');
    expect(result).toEqual({ field1: 'value1', field2: 'value2' });
  });

  it('hdel removes hash fields and returns count', async () => {
    c = await RedisClient.connect({ host: HOST, port: PORT, password: PASS, db: 15 });
    await c.hset('delhash', 'f1', 'v1');
    await c.hset('delhash', 'f2', 'v2');
    const deleted = await c.hdel('delhash', ['f1', 'missing']);
    expect(deleted).toBe(1);
    const remaining = await c.hgetall('delhash');
    expect(remaining).toEqual({ f2: 'v2' });
  });

  it('hgetall on missing hash returns empty object', async () => {
    c = await RedisClient.connect({ host: HOST, port: PORT, password: PASS, db: 15 });
    expect(await c.hgetall('nonexistent')).toEqual({});
  });
});
