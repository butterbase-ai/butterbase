import { describe, it, expect, vi, beforeEach } from 'vitest';

// getDbSize sizes every provisioned app database. It used to do that one app at
// a time: a 25-app org spent ~14s of a 16.7s /dashboard/billing response here.

const redisStore = vi.hoisted(() => new Map<string, string>());
const redis = vi.hoisted(() => ({
  get: vi.fn(async (k: string) => redisStore.get(k) ?? null),
  setex: vi.fn(async (k: string, _ttl: number, v: string) => { redisStore.set(k, v); return 'OK'; }),
  set: vi.fn(async (k: string, v: string, ..._args: unknown[]) => {
    if (redisStore.has(k)) return null;
    redisStore.set(k, v);
    return 'OK';
  }),
  del: vi.fn(async (k: string) => { redisStore.delete(k); return 1; }),
}));
vi.mock('./redis.js', () => ({ getRedisClient: () => redis }));

const apps = vi.hoisted(() => ({ rows: [] as Array<{ id: string; db_name: string; connection_string: string | null }> }));
vi.mock('./runtime-db.js', () => ({
  getRuntimeDbPool: () => ({ query: vi.fn(async () => ({ rows: apps.rows })) }),
}));
vi.mock('../config.js', () => ({ config: { runtimeDb: { urlsByRegion: { 'us-east-1': 'x' } } } }));
vi.mock('./region-resolver.js', () => ({ getRuntimeDbForApp: vi.fn() }));
vi.mock('./org-resolver.js', () => ({ resolveOrganizationId: vi.fn() }));
vi.mock('./credits-email.js', () => ({ fireCreditsEmailForOrg: vi.fn() }));

// Each per-app Pool answers pg_database_size after a short delay and records
// how many are open at once.
const pg = vi.hoisted(() => ({ open: 0, maxOpen: 0, created: 0 }));
vi.mock('pg', () => {
  class Pool {
    constructor() { pg.created++; }
    async query() {
      pg.open++;
      pg.maxOpen = Math.max(pg.maxOpen, pg.open);
      await new Promise((r) => setTimeout(r, 5));
      pg.open--;
      return { rows: [{ size: '1000' }] };
    }
    async end() {}
  }
  return { Pool, default: { Pool } };
});

import { getDbSize, DB_SIZE_CONCURRENCY } from './usage-metering.js';

const ORG = 'org_1';
const manyApps = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `app_${i}`, db_name: `db_${i}`, connection_string: `postgres://h/db_${i}` }));

describe('getDbSize', () => {
  beforeEach(() => {
    redisStore.clear();
    Object.assign(pg, { open: 0, maxOpen: 0, created: 0 });
    apps.rows = manyApps(25);
    vi.clearAllMocks();
  });

  it('sizes apps concurrently, at most DB_SIZE_CONCURRENCY at a time', async () => {
    const total = await getDbSize({} as never, ORG);

    expect(total).toBe(25 * 1000);
    expect(pg.created).toBe(25);
    expect(pg.maxOpen).toBeGreaterThan(1);
    expect(pg.maxOpen).toBeLessThanOrEqual(DB_SIZE_CONCURRENCY);
    expect(redisStore.get(`db_size_org:${ORG}`)).toBe('25000');
    expect(redisStore.get(`db_size_org_last:${ORG}`)).toBe('25000');
  });

  it('serves a fresh cached value without measuring', async () => {
    redisStore.set(`db_size_org:${ORG}`, '123');

    expect(await getDbSize({} as never, ORG)).toBe(123);
    expect(pg.created).toBe(0);
  });

  it('answers a stale org from its last known size and refreshes once in the background', async () => {
    redisStore.set(`db_size_org_last:${ORG}`, '777');

    const [a, b] = await Promise.all([getDbSize({} as never, ORG), getDbSize({} as never, ORG)]);

    expect(a).toBe(777);
    expect(b).toBe(777);
    // Both readers found it stale; the lock lets exactly one refresh run.
    await vi.waitFor(() => expect(redisStore.get(`db_size_org:${ORG}`)).toBe('25000'));
    expect(pg.created).toBe(25);
    expect(redisStore.has(`db_size_org_refreshing:${ORG}`)).toBe(false);
  });

  it('skips apps without a connection string and apps whose database errors', async () => {
    apps.rows = [...manyApps(2), { id: 'no_conn', db_name: 'x', connection_string: null }];

    expect(await getDbSize({} as never, ORG)).toBe(2000);
    expect(pg.created).toBe(2);
  });
});
