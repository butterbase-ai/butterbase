import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Redis } from 'ioredis';
import {
  readCatalogEntry, listCatalogModels, writeCatalog, readEnabledRouters,
  tryAcquireRefreshLock, releaseRefreshLock, recordUnknownId,
  inheritMissingChatPrices,
  type CatalogEntry,
} from './catalog.js';
import type { CatalogRouter } from './select.js';

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


// Pure — no Redis, so these always run.
describe('inheritMissingChatPrices', () => {
  const chat = (over: Partial<CatalogRouter>): CatalogRouter => ({
    name: 'openrouter', upstreamId: 'u', promptPricePerMtok: 0,
    completionPricePerMtok: 0, contextLength: 0, modality: 'chat', ...over,
  } as CatalogRouter);

  it('fills an unpriced chat route from a priced sibling', () => {
    const out = inheritMissingChatPrices([
      chat({ name: 'openrouter', promptPricePerMtok: 0.15, completionPricePerMtok: 0.47 }),
      chat({ name: 'provider-tertiary' }),
    ]);
    const t = out.find(r => r.name === 'provider-tertiary')!;
    expect(t.promptPricePerMtok).toBe(0.15);
    expect(t.completionPricePerMtok).toBe(0.47);
    expect(t.priceInheritedFrom).toBe('openrouter');
  });

  it('leaves the donor untouched', () => {
    const out = inheritMissingChatPrices([
      chat({ name: 'openrouter', promptPricePerMtok: 0.15, completionPricePerMtok: 0.47 }),
      chat({ name: 'provider-tertiary' }),
    ]);
    const d = out.find(r => r.name === 'openrouter')!;
    expect(d.priceInheritedFrom).toBeUndefined();
    expect(d.promptPricePerMtok).toBe(0.15);
  });

  it('prefers openrouter as donor even when a cheaper sibling exists', () => {
    const out = inheritMissingChatPrices([
      chat({ name: 'provider-secondary', promptPricePerMtok: 0.01, completionPricePerMtok: 0.02 }),
      chat({ name: 'openrouter', promptPricePerMtok: 0.15, completionPricePerMtok: 0.47 }),
      chat({ name: 'provider-tertiary' }),
    ]);
    expect(out.find(r => r.name === 'provider-tertiary')!.priceInheritedFrom).toBe('openrouter');
    expect(out.find(r => r.name === 'provider-tertiary')!.promptPricePerMtok).toBe(0.15);
  });

  it('falls back to the CHEAPEST sibling when openrouter is absent', () => {
    const out = inheritMissingChatPrices([
      chat({ name: 'provider-quaternary', promptPricePerMtok: 2, completionPricePerMtok: 6 }),
      chat({ name: 'provider-secondary', promptPricePerMtok: 0.5, completionPricePerMtok: 1 }),
      chat({ name: 'provider-tertiary' }),
    ]);
    const t = out.find(r => r.name === 'provider-tertiary')!;
    // cheapest by prompt + 3*completion: secondary 3.5 vs quaternary 20
    expect(t.priceInheritedFrom).toBe('provider-secondary');
    expect(t.promptPricePerMtok).toBe(0.5);
  });

  it('never touches video rows — 0/0 there is by design, priced via rawPricing', () => {
    const video: CatalogRouter = {
      name: 'provider-tertiary', upstreamId: 'seedance-2.0', promptPricePerMtok: 0,
      completionPricePerMtok: 0, contextLength: 0, modality: 'video',
      rawPricing: { unit: 'second', variants: [] },
    } as CatalogRouter;
    const out = inheritMissingChatPrices([
      chat({ name: 'openrouter', promptPricePerMtok: 0.15, completionPricePerMtok: 0.47 }),
      video,
    ]);
    const v = out.find(r => r.modality === 'video')!;
    expect(v.promptPricePerMtok).toBe(0);
    expect(v.completionPricePerMtok).toBe(0);
    expect(v.priceInheritedFrom).toBeUndefined();
  });

  it('skips rows carrying rawPricing even when modality says chat', () => {
    const out = inheritMissingChatPrices([
      chat({ name: 'openrouter', promptPricePerMtok: 0.15, completionPricePerMtok: 0.47 }),
      chat({ name: 'provider-secondary', rawPricing: { unit: 'image' } }),
    ]);
    expect(out.find(r => r.name === 'provider-secondary')!.priceInheritedFrom).toBeUndefined();
  });

  it('treats a missing modality as chat (legacy rows)', () => {
    const legacy = { name: 'provider-tertiary', upstreamId: 'u', promptPricePerMtok: 0,
      completionPricePerMtok: 0, contextLength: 0 } as CatalogRouter;
    const out = inheritMissingChatPrices([
      chat({ name: 'openrouter', promptPricePerMtok: 1, completionPricePerMtok: 2 }),
      legacy,
    ]);
    expect(out.find(r => r.name === 'provider-tertiary')!.priceInheritedFrom).toBe('openrouter');
  });

  it('is a no-op when no sibling has a price', () => {
    const input = [chat({ name: 'openrouter' }), chat({ name: 'provider-tertiary' })];
    expect(inheritMissingChatPrices(input)).toEqual(input);
  });

  it('is a no-op for a single priced router', () => {
    const input = [chat({ name: 'openrouter', promptPricePerMtok: 1, completionPricePerMtok: 2 })];
    expect(inheritMissingChatPrices(input)).toEqual(input);
  });

  it('inherits when only the completion price is non-zero', () => {
    const out = inheritMissingChatPrices([
      chat({ name: 'openrouter', promptPricePerMtok: 0, completionPricePerMtok: 0.47 }),
      chat({ name: 'provider-tertiary' }),
    ]);
    expect(out.find(r => r.name === 'provider-tertiary')!.completionPricePerMtok).toBe(0.47);
  });
});
