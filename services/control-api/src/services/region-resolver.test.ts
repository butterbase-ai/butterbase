import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveAppRegion, invalidateAppRegion } from './region-resolver.js';

const fakeRedis = () => {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => { store.set(k, v); return 'OK'; }),
    setex: vi.fn(async (k: string, _ttl: number, v: string) => { store.set(k, v); return 'OK'; }),
    del: vi.fn(async (k: string) => { store.delete(k); return 1; }),
  };
};

describe('resolveAppRegion', () => {
  let pool: any;
  let redis: any;

  beforeEach(() => {
    redis = fakeRedis();
    pool = {
      query: vi.fn().mockResolvedValue({ rows: [{ region: 'us-east-1' }] }),
    };
  });

  it('reads from org_app_index on cache miss and caches', async () => {
    const r = await resolveAppRegion(pool, redis, 'app-1');
    expect(r).toBe('us-east-1');
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(pool.query.mock.calls[0][0]).toMatch(/org_app_index/);
    expect(redis.setex).toHaveBeenCalledWith('app-region:app-1', 300, 'us-east-1');
  });

  it('returns the cached region without a DB hit', async () => {
    await resolveAppRegion(pool, redis, 'app-1');
    pool.query.mockClear();
    const r = await resolveAppRegion(pool, redis, 'app-1');
    expect(r).toBe('us-east-1');
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('returns null when the app is unknown', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const r = await resolveAppRegion(pool, redis, 'missing');
    expect(r).toBeNull();
  });
});

describe('invalidateAppRegion', () => {
  it('deletes the cached entry', async () => {
    const redis = fakeRedis();
    await redis.setex('app-region:app-1', 300, 'us-east-1');
    await invalidateAppRegion(redis, 'app-1');
    expect(await redis.get('app-region:app-1')).toBeNull();
  });
});
