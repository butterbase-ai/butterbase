/**
 * Promo coverage: a call paid for by a provider coupon must not lease or charge
 * the caller's credits, and must record the authoritative post-call cost
 * against the promo budget.
 *
 * The bug these guard against shipped as two parallel ledgers: a promo counter
 * that ticked down while the billing gate charged the user anyway, and 402'd a
 * zero-balance user on a call advertised as free.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { routeChatCompletion } from './router.js';
import { setPromoCoverage } from './promo-coverage-registry.js';
import { AdapterError } from './adapters/types.js';
import type { RouterAdapter } from './adapters/types.js';
import * as billingGate from './billing-gate.js';
import * as usageLog from './usage-log.js';

vi.mock('./billing-gate.js', () => ({
  acquireForEstimatedCost: vi.fn(async () => ({ leaseId: 'lease-1', amountGrantedUsd: 1, expiresAt: new Date() })),
  acquireNominal: vi.fn(async () => ({ leaseId: 'lease-1', amountGrantedUsd: 1, expiresAt: new Date() })),
  settleAfterCall: vi.fn(async () => ({ refundedUsd: 0 })),
  leaseTtlSeconds: vi.fn(() => 60),
  InsufficientCreditsError: class InsufficientCreditsError extends Error {},
}));

vi.mock('./usage-log.js', () => ({ writeAiUsageRow: vi.fn(async () => {}) }));
vi.mock('../auto-refill-service.js', () => ({ maybeTriggerAutoRefill: vi.fn(() => Promise.resolve()) }));

const COVERED_MODEL = 'm';
/** The router the coupon actually pays for. */
const FUNDED = 'provider-quaternary';

function entry() {
  return {
    canonicalId: COVERED_MODEL,
    displayName: COVERED_MODEL,
    updatedAt: new Date().toISOString(),
    // 1000 prompt + 500 completion @ $1/Mtok each = $0.0015 provider cost.
    // Two routers on purpose: a single-router catalog cannot express a fallback,
    // and that is exactly what hid the unfunded-fallback bug.
    routers: [
      { name: FUNDED, upstreamId: COVERED_MODEL, promptPricePerMtok: 1, completionPricePerMtok: 1, contextLength: 1000 },
      { name: 'openrouter', upstreamId: COVERED_MODEL, promptPricePerMtok: 1, completionPricePerMtok: 1, contextLength: 1000 },
    ],
  };
}

function makeRedis() {
  return {
    mget: vi.fn(async () => []),
    get: vi.fn(async (key: string) => {
      if (key === `ai_catalog:model:${COVERED_MODEL}`) return JSON.stringify(entry());
      if (key === 'ai_catalog:routers') return JSON.stringify([{ name: FUNDED, enabled: true }, { name: 'openrouter', enabled: true }]);
      return null;
    }),
  } as any;
}

function makePoolStub() {
  return {
    connect: vi.fn(async () => ({
      query: vi.fn(async () => ({ rows: [{ user_id: 'u', credits_usd: '100', amount_usd: '100', status: 'active' }] })),
      release: vi.fn(),
    })),
    query: vi.fn(async () => ({ rows: [] })),
  } as any;
}

function adapterReturning(usage: { prompt_tokens: number; completion_tokens: number }): RouterAdapter {
  return {
    capabilities: { supportsNativeMessages: () => false },
    toUpstreamId: (id: string) => id,
    listModels: async () => [],
    chatCompletion: async () => ({
      status: 200,
      body: { usage },
      usage: { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens, totalCost: null },
    }),
  } as any;
}

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    platformPool: makePoolStub(),
    runtimePool: makePoolStub(),
    redis: makeRedis(),
    adapters: new Map<string, RouterAdapter>([
      [FUNDED, adapterReturning({ prompt_tokens: 1000, completion_tokens: 500 })],
      ['openrouter', adapterReturning({ prompt_tokens: 1000, completion_tokens: 500 })],
    ]),
    markupPct: 20,
    markupSource: 'default',
    appId: 'app_1',
    organizationId: 'org_1',
    userId: 'u',
    region: 'us-east-1',
    stickyBindings: { get: async () => null, set: async () => {}, delete: async () => {} },
    ...overrides,
  } as any;
}

const req = { model: COVERED_MODEL, messages: [{ role: 'user', content: 'hi' }] } as any;

beforeEach(() => {
  vi.clearAllMocks();
  setPromoCoverage(null);
});

afterEach(() => setPromoCoverage(null));

describe('promo coverage — admission', () => {
  it('does not lease credits for a covered call', async () => {
    setPromoCoverage({ fundedRouter: async () => FUNDED, record: async () => {} });

    await routeChatCompletion(makeCtx(), req);

    expect(billingGate.acquireForEstimatedCost).not.toHaveBeenCalled();
    expect(billingGate.acquireNominal).not.toHaveBeenCalled();
  });

  it('still leases credits when the call is not covered', async () => {
    setPromoCoverage({ fundedRouter: async () => null, record: async () => {} });

    await routeChatCompletion(makeCtx(), req);

    expect(billingGate.acquireForEstimatedCost).toHaveBeenCalledTimes(1);
  });

  it('bills normally when the coverage backend throws', async () => {
    setPromoCoverage({
      fundedRouter: async () => { throw new Error('redis down'); },
      record: async () => {},
    });

    await routeChatCompletion(makeCtx(), req);

    // Failing open to "free" would give the coupon away against a budget we
    // cannot read; failing closed to paid billing is recoverable.
    expect(billingGate.acquireForEstimatedCost).toHaveBeenCalledTimes(1);
  });
});

describe('promo coverage — settlement', () => {
  it('records the provider cost against the promo instead of charging credits', async () => {
    const record = vi.fn(async () => {});
    setPromoCoverage({ fundedRouter: async () => FUNDED, record });

    await routeChatCompletion(makeCtx(), req);

    expect(billingGate.settleAfterCall).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledTimes(1);
    // Pre-markup provider cost: (1000 + 500) tokens @ $1/Mtok.
    expect(record).toHaveBeenCalledWith(COVERED_MODEL, 0.0015);
  });

  it('charges credits and records nothing when not covered', async () => {
    const record = vi.fn(async () => {});
    setPromoCoverage({ fundedRouter: async () => null, record });

    await routeChatCompletion(makeCtx(), req);

    expect(billingGate.settleAfterCall).toHaveBeenCalledTimes(1);
    expect(record).not.toHaveBeenCalled();
  });

  it('completes the call when recording promo spend fails', async () => {
    setPromoCoverage({
      fundedRouter: async () => FUNDED,
      record: async () => { throw new Error('redis down'); },
    });

    const res = await routeChatCompletion(makeCtx(), req);

    expect(res.status).toBe(200);
  });
});

describe('promo coverage — usage row', () => {
  it('reports a covered call as unbilled with no lease', async () => {
    setPromoCoverage({ fundedRouter: async () => FUNDED, record: async () => {} });

    await routeChatCompletion(makeCtx(), req);

    expect(usageLog.writeAiUsageRow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        chargedToUser: false,
        chargedCreditsUsd: 0,
        leaseId: null,
        // The coupon still cost us real money — keep it reportable.
        providerCostUsd: 0.0015,
      }),
    );
  });

  it('reports an uncovered call as billed against its lease', async () => {
    setPromoCoverage({ fundedRouter: async () => null, record: async () => {} });

    await routeChatCompletion(makeCtx(), req);

    expect(usageLog.writeAiUsageRow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ chargedToUser: true, leaseId: 'lease-1' }),
    );
  });
});

describe('promo coverage — fallback to an unfunded router', () => {
  /** Funded router fails over, so the call lands on one the coupon does not pay for. */
  function ctxWithFailingFundedRouter() {
    const failing = {
      capabilities: { supportsNativeMessages: () => false },
      toUpstreamId: (id: string) => id,
      listModels: async () => [],
      chatCompletion: async () => { throw new AdapterError(FUNDED, 503, 'transport', 'boom'); },
    } as any;
    return makeCtx({
      adapters: new Map<string, RouterAdapter>([
        [FUNDED, failing],
        ['openrouter', adapterReturning({ prompt_tokens: 1000, completion_tokens: 500 })],
      ]),
    });
  }

  it('leases and charges the caller when the call falls back off the funded router', async () => {
    const record = vi.fn(async () => {});
    setPromoCoverage({ fundedRouter: async () => FUNDED, record });

    await routeChatCompletion(ctxWithFailingFundedRouter(), req);

    // The coupon does not pay OpenRouter, so this must not be free and must not
    // be booked against the promo budget.
    expect(billingGate.acquireForEstimatedCost).toHaveBeenCalledTimes(1);
    expect(billingGate.settleAfterCall).toHaveBeenCalledTimes(1);
    expect(record).not.toHaveBeenCalled();
  });

  it('reports a fallen-back call as billed to the user', async () => {
    setPromoCoverage({ fundedRouter: async () => FUNDED, record: async () => {} });

    await routeChatCompletion(ctxWithFailingFundedRouter(), req);

    expect(usageLog.writeAiUsageRow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ chargedToUser: true, leaseId: 'lease-1' }),
    );
  });

  it('acquires the lease before contacting the unfunded upstream', async () => {
    const order: string[] = [];
    (billingGate.acquireForEstimatedCost as any).mockImplementationOnce(async () => {
      order.push('lease');
      return { leaseId: 'lease-1', amountGrantedUsd: 1, expiresAt: new Date() };
    });
    const openrouter = {
      capabilities: { supportsNativeMessages: () => false },
      toUpstreamId: (id: string) => id,
      listModels: async () => [],
      chatCompletion: async () => {
        order.push('upstream');
        return { status: 200, body: {}, usage: { promptTokens: 1000, completionTokens: 500, totalCost: null } };
      },
    } as any;
    const failing = {
      capabilities: { supportsNativeMessages: () => false },
      toUpstreamId: (id: string) => id,
      listModels: async () => [],
      chatCompletion: async () => { throw new AdapterError(FUNDED, 503, 'transport', 'boom'); },
    } as any;
    setPromoCoverage({ fundedRouter: async () => FUNDED, record: async () => {} });

    await routeChatCompletion(
      makeCtx({ adapters: new Map<string, RouterAdapter>([[FUNDED, failing], ['openrouter', openrouter]]) }),
      req,
    );

    // Leasing after the call would mean spending money we might not be able to
    // bill for.
    expect(order).toEqual(['lease', 'upstream']);
  });

  it('does not cover the call at all when the funded router is not in the catalog', async () => {
    const record = vi.fn(async () => {});
    setPromoCoverage({ fundedRouter: async () => 'provider-nonexistent', record });

    await routeChatCompletion(makeCtx(), req);

    expect(billingGate.acquireForEstimatedCost).toHaveBeenCalledTimes(1);
    expect(record).not.toHaveBeenCalled();
  });
});
