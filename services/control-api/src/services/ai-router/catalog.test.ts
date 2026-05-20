import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Redis } from 'ioredis';
import {
  readCatalogEntry, listCatalogModels, writeCatalog, readEnabledRouters,
  tryAcquireRefreshLock, releaseRefreshLock, recordUnknownId,
  type CatalogEntry,
} from './catalog.js';

const RUN_REDIS_TESTS = process.env.RUN_REDIS_TESTS === '1' || process.env.RUN_DB_TESTS === '1';
const describeRedis = RUN_REDIS_TESTS ? describe : describe.skip;

describeRedis('catalog', () => {
  let redis: Redis;

  beforeAll(() => {
    redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
  });
  afterAll(async () => { await redis.quit(); });
  beforeEach(async () => {
    const keys = await redis.keys('ai_catalog:*');
    if (keys.length > 0) await redis.del(...keys);
  });

  function makeEntry(canonical: string, router: 'openrouter' | 'provider-primary'): CatalogEntry {
    return {
      canonicalId: canonical,
      displayName: canonical,
      updatedAt: new Date().toISOString(),
      routers: [{
        name: router as any,
        upstreamId: canonical,
        promptPricePerMtok: 1,
        completionPricePerMtok: 1,
        contextLength: 100000,
      }],
    };
  }

  it('writeCatalog persists entries and they are readable', async () => {
    const e = makeEntry('anthropic/claude-3-5-sonnet', 'openrouter');
    await writeCatalog(redis, [e], [{ name: 'openrouter', enabled: true, lastRefreshAt: new Date().toISOString(), lastRefreshStatus: 'ok' }]);

    const r = await readCatalogEntry(redis, 'anthropic/claude-3-5-sonnet');
    expect(r?.routers).toHaveLength(1);
    expect(r?.routers[0].name).toBe('openrouter');

    const models = await listCatalogModels(redis);
    expect(models).toContain('anthropic/claude-3-5-sonnet');

    const routers = await readEnabledRouters(redis);
    expect(routers.find(r => r.name === 'openrouter')?.enabled).toBe(true);
  });

  it('readCatalogEntry returns null for unknown canonical id', async () => {
    expect(await readCatalogEntry(redis, 'unknown/model')).toBeNull();
  });

  it('writeCatalog flips the catalog atomically (no stale entries linger)', async () => {
    await writeCatalog(redis, [makeEntry('a/b', 'openrouter')], [{ name: 'openrouter', enabled: true, lastRefreshAt: new Date().toISOString(), lastRefreshStatus: 'ok' }]);
    await writeCatalog(redis, [makeEntry('c/d', 'provider-primary')], [{ name: 'provider-primary', enabled: true, lastRefreshAt: new Date().toISOString(), lastRefreshStatus: 'ok' }]);
    expect(await readCatalogEntry(redis, 'a/b')).toBeNull();
    expect(await readCatalogEntry(redis, 'c/d')).not.toBeNull();
    const models = await listCatalogModels(redis);
    expect(models).toEqual(['c/d']);
  });

  it('tryAcquireRefreshLock returns true once then false until released', async () => {
    expect(await tryAcquireRefreshLock(redis, 60)).toBe(true);
    expect(await tryAcquireRefreshLock(redis, 60)).toBe(false);
    await releaseRefreshLock(redis);
    expect(await tryAcquireRefreshLock(redis, 60)).toBe(true);
  });

  it('recordUnknownId stores router:id in the unknown set', async () => {
    await recordUnknownId(redis, 'provider-primary', 'weird-model-1');
    await recordUnknownId(redis, 'provider-primary', 'weird-model-2');
    const members = await redis.smembers('ai_catalog:unknown');
    expect(members.sort()).toEqual(['provider-primary:weird-model-1', 'provider-primary:weird-model-2']);
  });
});
