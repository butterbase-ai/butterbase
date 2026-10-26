/**
 * Read-only model-funding inspection for cloud access policies.
 *
 * The gateway remains authoritative: this only answers "could this
 * organization fund this model right now" without leasing, reserving,
 * debiting, calling a provider, or allocating a sandbox. Provider-funded
 * coverage counts only while the coupon's router is enabled and actually
 * ranks for the model; an unavailable coupon must fall through to the
 * credit-floor check rather than authorize an unfunded fallback.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';

const catalog = vi.hoisted(() => ({
  readCatalogEntry: vi.fn(),
  readEnabledRouters: vi.fn(),
}));

vi.mock('./catalog.js', () => catalog);
vi.mock('../redis.js', () => ({ getRedisClient: () => ({}) }));

import { setPromoCoverage } from './promo-coverage-registry.js';
import * as promoCoverage from './promo-coverage-registry.js';
import * as leaseService from '../lease-service.js';
import { inspectModelFunding } from './model-funding.js';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const MODEL = 'qwen/qwen3-max';
const FUNDED_ROUTER = 'provider-quaternary';

interface CreditRow {
  monthly: number;
  credits: number;
  floor: number;
}

/**
 * Fake control pool. Rows are consumed in order; the final row repeats so a
 * test can express "before and after a top-up" with two entries.
 */
function makePool(...rows: Array<CreditRow | null>) {
  let index = 0;
  const query = vi.fn(async (_sql: string, _params?: unknown[]) => {
    const row = rows[Math.min(index, rows.length - 1)];
    index += 1;
    return {
      rows: row
        ? [{
            monthly_allowance_usd: row.monthly.toFixed(4),
            credits_usd: row.credits.toFixed(4),
            credit_floor_usd: row.floor.toFixed(4),
          }]
        : [],
    };
  });
  const connect = vi.fn(() => {
    throw new Error('funding inspection must not open a transaction');
  });
  return { query, connect } as unknown as pg.Pool & {
    query: typeof query;
    connect: typeof connect;
  };
}

function entry(routerNames: string[]) {
  return {
    canonicalId: MODEL,
    displayName: MODEL,
    updatedAt: new Date().toISOString(),
    routers: routerNames.map(name => ({
      name,
      upstreamId: MODEL,
      promptPricePerMtok: 1,
      completionPricePerMtok: 1,
      contextLength: 1000,
    })),
  };
}

function enabledRouters(names: string[]) {
  return names.map(name => ({
    name,
    enabled: true,
    lastRefreshAt: new Date().toISOString(),
    lastRefreshStatus: 'ok' as const,
  }));
}

function cover(fundedRouter: string | ((canonicalId: string) => string | null)) {
  setPromoCoverage({
    fundedRouter: async canonicalId =>
      typeof fundedRouter === 'function' ? fundedRouter(canonicalId) : fundedRouter,
    record: async () => {},
  });
}

afterEach(() => setPromoCoverage(null));

beforeEach(() => {
  vi.clearAllMocks();
  catalog.readCatalogEntry.mockResolvedValue(null);
  catalog.readEnabledRouters.mockResolvedValue([]);
});

describe('inspectModelFunding', () => {
  it('allows a provider-funded model below the credit floor', async () => {
    cover(FUNDED_ROUTER);
    catalog.readCatalogEntry.mockResolvedValue(entry([FUNDED_ROUTER, 'openrouter']));
    catalog.readEnabledRouters.mockResolvedValue(enabledRouters([FUNDED_ROUTER, 'openrouter']));

    const result = await inspectModelFunding(makePool({ monthly: 0, credits: -1, floor: 0 }), {
      organizationId: ORG_ID,
      userId: USER_ID,
      model: MODEL,
    });

    expect(result).toEqual({ allowed: true, source: 'provider', reason: null });
  });

  it('does not authorize an unfunded fallback when the coupon router is disabled', async () => {
    cover(FUNDED_ROUTER);
    catalog.readCatalogEntry.mockResolvedValue(entry([FUNDED_ROUTER, 'openrouter']));
    // The funded router exists in the catalog but is disabled, so the call
    // would fall back to an unfunded router.
    catalog.readEnabledRouters.mockResolvedValue(enabledRouters(['openrouter']));

    const result = await inspectModelFunding(makePool({ monthly: 0, credits: -1, floor: 0 }), {
      organizationId: ORG_ID,
      userId: USER_ID,
      model: MODEL,
    });

    expect(result).toEqual({ allowed: false, source: 'none', reason: 'credits_required' });
  });

  it('does not authorize a coupon whose router does not serve the model', async () => {
    cover(FUNDED_ROUTER);
    catalog.readCatalogEntry.mockResolvedValue(entry(['openrouter']));
    catalog.readEnabledRouters.mockResolvedValue(enabledRouters([FUNDED_ROUTER, 'openrouter']));

    const result = await inspectModelFunding(makePool({ monthly: 0, credits: -1, floor: 0 }), {
      organizationId: ORG_ID,
      userId: USER_ID,
      model: MODEL,
    });

    expect(result).toEqual({ allowed: false, source: 'none', reason: 'credits_required' });
  });

  it('falls back to credits at the effective floor when the coupon router is unavailable', async () => {
    cover(FUNDED_ROUTER);
    catalog.readCatalogEntry.mockResolvedValue(entry([FUNDED_ROUTER]));
    catalog.readEnabledRouters.mockResolvedValue(enabledRouters([]));

    const result = await inspectModelFunding(makePool({ monthly: 0, credits: -25, floor: -25 }), {
      organizationId: ORG_ID,
      userId: USER_ID,
      model: MODEL,
    });

    expect(result).toEqual({ allowed: true, source: 'credits', reason: null });
  });

  it('admits credits when the combined balance is exactly at the floor', async () => {
    const result = await inspectModelFunding(makePool({ monthly: 1, credits: -26, floor: -25 }), {
      organizationId: ORG_ID,
      userId: USER_ID,
      model: MODEL,
    });

    expect(result).toEqual({ allowed: true, source: 'credits', reason: null });
    expect(catalog.readCatalogEntry).not.toHaveBeenCalled();
    expect(catalog.readEnabledRouters).not.toHaveBeenCalled();
  });

  it('denies credits below the effective floor', async () => {
    const result = await inspectModelFunding(makePool({ monthly: 1, credits: -26.0001, floor: -25 }), {
      organizationId: ORG_ID,
      userId: USER_ID,
      model: MODEL,
    });

    expect(result).toEqual({ allowed: false, source: 'none', reason: 'credits_required' });
  });

  it('uses the effective floor rather than assuming zero', async () => {
    const below = await inspectModelFunding(makePool({ monthly: 0, credits: 9.9999, floor: 10 }), {
      organizationId: ORG_ID,
      userId: USER_ID,
      model: MODEL,
    });
    const at = await inspectModelFunding(makePool({ monthly: 0, credits: 10, floor: 10 }), {
      organizationId: ORG_ID,
      userId: USER_ID,
      model: MODEL,
    });

    expect(below).toEqual({ allowed: false, source: 'none', reason: 'credits_required' });
    expect(at).toEqual({ allowed: true, source: 'credits', reason: null });
  });

  it('denies when the organization does not exist', async () => {
    const result = await inspectModelFunding(makePool(null), {
      organizationId: ORG_ID,
      userId: USER_ID,
      model: MODEL,
    });

    expect(result).toEqual({ allowed: false, source: 'none', reason: 'credits_required' });
  });

  it('denies with service_unavailable when the balance read fails', async () => {
    const pool = makePool({ monthly: 0, credits: 0, floor: 0 });
    (pool.query as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('database down'));

    const result = await inspectModelFunding(pool, {
      organizationId: ORG_ID,
      userId: USER_ID,
      model: MODEL,
    });

    expect(result).toEqual({ allowed: false, source: 'none', reason: 'service_unavailable' });
  });

  it('denies with service_unavailable when catalog state cannot be read for a coupon', async () => {
    cover(FUNDED_ROUTER);
    catalog.readCatalogEntry.mockRejectedValueOnce(new Error('redis down'));

    const result = await inspectModelFunding(makePool({ monthly: 0, credits: 100, floor: 0 }), {
      organizationId: ORG_ID,
      userId: USER_ID,
      model: MODEL,
    });

    expect(result).toEqual({ allowed: false, source: 'none', reason: 'service_unavailable' });
  });

  it('recovers after a top-up without caching the denied decision', async () => {
    const pool = makePool(
      { monthly: 0, credits: -1, floor: 0 },
      { monthly: 0, credits: 1, floor: 0 },
    );
    const input = { organizationId: ORG_ID, userId: USER_ID, model: MODEL };

    expect(await inspectModelFunding(pool, input)).toEqual({
      allowed: false, source: 'none', reason: 'credits_required',
    });
    expect(await inspectModelFunding(pool, input)).toEqual({
      allowed: true, source: 'credits', reason: null,
    });
  });

  it('recovers when provider coverage changes', async () => {
    cover(FUNDED_ROUTER);
    catalog.readCatalogEntry.mockResolvedValue(entry([FUNDED_ROUTER]));
    catalog.readEnabledRouters.mockResolvedValue(enabledRouters([FUNDED_ROUTER]));
    const pool = makePool(
      { monthly: 0, credits: -1, floor: 0 },
      { monthly: 0, credits: -1, floor: 0 },
    );
    const input = { organizationId: ORG_ID, userId: USER_ID, model: MODEL };

    expect(await inspectModelFunding(pool, input)).toEqual({
      allowed: true, source: 'provider', reason: null,
    });

    setPromoCoverage(null);

    expect(await inspectModelFunding(pool, input)).toEqual({
      allowed: false, source: 'none', reason: 'credits_required',
    });
  });

  it('re-evaluates funding when the model changes', async () => {
    cover(canonicalId => (canonicalId === MODEL ? FUNDED_ROUTER : null));
    catalog.readCatalogEntry.mockResolvedValue(entry([FUNDED_ROUTER]));
    catalog.readEnabledRouters.mockResolvedValue(enabledRouters([FUNDED_ROUTER]));
    const pool = makePool(
      { monthly: 0, credits: -1, floor: 0 },
      { monthly: 0, credits: -1, floor: 0 },
    );

    expect(await inspectModelFunding(pool, {
      organizationId: ORG_ID, userId: USER_ID, model: 'openai/gpt-x',
    })).toEqual({ allowed: false, source: 'none', reason: 'credits_required' });

    expect(await inspectModelFunding(pool, {
      organizationId: ORG_ID, userId: USER_ID, model: MODEL,
    })).toEqual({ allowed: true, source: 'provider', reason: null });
  });

  it('is strictly read-only: one SELECT, no transaction, lease, provider call, or spend record', async () => {
    const pool = makePool({ monthly: 0, credits: 1, floor: 0 });
    const grantLease = vi.spyOn(leaseService, 'grantLease');
    const settleLease = vi.spyOn(leaseService, 'settleLease');
    const recordPromoSpend = vi.spyOn(promoCoverage, 'recordPromoSpend');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await inspectModelFunding(pool, {
      organizationId: ORG_ID,
      userId: USER_ID,
      model: MODEL,
    });

    expect(pool.connect).not.toHaveBeenCalled();
    expect(grantLease).not.toHaveBeenCalled();
    expect(settleLease).not.toHaveBeenCalled();
    expect(recordPromoSpend).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql] = (pool.query as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(sql.trim().toUpperCase().startsWith('SELECT')).toBe(true);
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);

    grantLease.mockRestore();
    settleLease.mockRestore();
    recordPromoSpend.mockRestore();
    fetchSpy.mockRestore();
  });
});
