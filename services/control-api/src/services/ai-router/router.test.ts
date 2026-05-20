import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { routeChatCompletion, RouterError } from './router.js';
import { AdapterError, type RouterAdapter } from './adapters/types.js';

vi.mock('./billing-gate.js', () => ({
  acquireForEstimatedCost: vi.fn(async () => ({ leaseId: 'lease-1', amountGrantedUsd: 1, expiresAt: new Date() })),
  settleAfterCall: vi.fn(async () => ({ refundedUsd: 0 })),
  leaseTtlSeconds: vi.fn(() => 60),
  InsufficientCreditsError: class InsufficientCreditsError extends Error {},
}));

vi.mock('./usage-log.js', () => ({
  writeAiUsageRow: vi.fn(async () => {}),
}));

vi.mock('../auto-refill-service.js', () => ({
  maybeTriggerAutoRefill: vi.fn(() => Promise.resolve()),
}));

function makeRedis(catalogEntry: any, routers: any[]) {
  return {
    get: vi.fn(async (key: string) => {
      if (key === 'ai_catalog:model:m') return JSON.stringify(catalogEntry);
      if (key === 'ai_catalog:routers') return JSON.stringify(routers);
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

function entry(routerName: string, pp = 1, cp = 1) {
  return {
    canonicalId: 'm',
    displayName: 'm',
    updatedAt: new Date().toISOString(),
    routers: [{ name: routerName, upstreamId: 'm', promptPricePerMtok: pp, completionPricePerMtok: cp, contextLength: 1000 }],
  };
}

function entryMulti(...routers: Array<{ name: string; pp: number; cp: number }>) {
  return {
    canonicalId: 'm',
    displayName: 'm',
    updatedAt: new Date().toISOString(),
    routers: routers.map(r => ({ name: r.name, upstreamId: 'm', promptPricePerMtok: r.pp, completionPricePerMtok: r.cp, contextLength: 1000 })),
  };
}

describe('routeChatCompletion fallback', () => {
  it('throws MODEL_NOT_FOUND when the catalog has no entry', async () => {
    const ctx = {
      platformPool: makePoolStub(),
      runtimePool: makePoolStub(),
      redis: { get: vi.fn(async () => null) } as any,
      adapters: new Map(),
      markupPct: 20, appId: 'a', userId: 'u', region: 'r',
    };
    await expect(routeChatCompletion(ctx as any, { model: 'm', messages: [] }))
      .rejects.toBeInstanceOf(RouterError);
  });

  it('throws NO_ROUTERS_AVAILABLE when no routers are enabled', async () => {
    const ctx = {
      platformPool: makePoolStub(),
      runtimePool: makePoolStub(),
      redis: makeRedis(entry('openrouter'), [{ name: 'openrouter', enabled: false, lastRefreshAt: '', lastRefreshStatus: 'failed' }]),
      adapters: new Map(),
      markupPct: 20, appId: 'a', userId: 'u', region: 'r',
    };
    await expect(routeChatCompletion(ctx as any, { model: 'm', messages: [] }))
      .rejects.toMatchObject({ code: 'NO_ROUTERS_AVAILABLE' });
  });
});

describe('presence mode ranker selection', () => {
  let origPresenceMode: boolean;

  beforeEach(async () => {
    const { config } = await import('../../config.js');
    origPresenceMode = config.aiRouter.presenceModeEnabled;
  });

  afterEach(async () => {
    const { config } = await import('../../config.js');
    (config.aiRouter as any).presenceModeEnabled = origPresenceMode;
  });

  it('uses rankRoutersPresenceMode when config.aiRouter.presenceModeEnabled is true (provider-primary preferred over cheap openrouter)', async () => {
    const { config } = await import('../../config.js');
    (config.aiRouter as any).presenceModeEnabled = true;

    // openrouter is cheaper (pp=0.1) but presenceMode should prefer provider-primary
    const catalogEntry = entryMulti(
      { name: 'openrouter', pp: 0.1, cp: 0.1 },
      { name: 'provider-primary', pp: 10, cp: 10 },
    );

    const erAdapter: RouterAdapter = {
      toUpstreamId: () => 'm',
      chatCompletion: vi.fn(async () => ({
        status: 200, body: { id: 'r', object: 'chat.completion', model: 'm', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
        usage: { promptTokens: 1, completionTokens: 1 },
      })),
    };
    const orAdapter: RouterAdapter = {
      toUpstreamId: () => 'm',
      chatCompletion: vi.fn(async () => ({
        status: 200, body: {},
        usage: { promptTokens: 1, completionTokens: 1 },
      })),
    };

    const adapters = new Map<string, RouterAdapter>([
      ['provider-primary', erAdapter],
      ['openrouter', orAdapter],
    ]);

    const redis = makeRedis(catalogEntry, [
      { name: 'openrouter', enabled: true },
      { name: 'provider-primary', enabled: true },
    ]);

    const ctx = {
      platformPool: makePoolStub(),
      runtimePool: makePoolStub(),
      redis,
      adapters,
      markupPct: 0, appId: 'a', userId: 'u', region: 'r',
    };

    await routeChatCompletion(ctx as any, { model: 'm', messages: [{ role: 'user', content: 'hi' }] });

    // provider-primary should be called, not openrouter (despite openrouter being cheaper)
    expect(erAdapter.chatCompletion).toHaveBeenCalledTimes(1);
    expect(orAdapter.chatCompletion).not.toHaveBeenCalled();
  });
});

describe('presence mode fallback', () => {
  let origPresenceMode: boolean;

  beforeEach(async () => {
    const { config } = await import('../../config.js');
    origPresenceMode = config.aiRouter.presenceModeEnabled;
  });

  afterEach(async () => {
    const { config } = await import('../../config.js');
    (config.aiRouter as any).presenceModeEnabled = origPresenceMode;
  });

  it('presenceModeEnabled=true: ER throws transport AdapterError, falls back to OR and returns OR success', async () => {
    const { config } = await import('../../config.js');
    (config.aiRouter as any).presenceModeEnabled = true;

    // ER is preferred by presence mode (higher price = presence preferred)
    const catalogEntry = entryMulti(
      { name: 'openrouter', pp: 0.1, cp: 0.1 },
      { name: 'provider-primary', pp: 10, cp: 10 },
    );

    const orSuccessBody = { id: 'r-or', object: 'chat.completion', model: 'm', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };

    const erAdapter: RouterAdapter = {
      name: 'provider-primary' as any,
      toUpstreamId: () => 'm',
      listModels: vi.fn(async () => []),
      chatCompletion: vi.fn(async () => {
        throw new AdapterError('provider-primary' as any, 502, 'transport', 'connection refused');
      }),
    };
    const orAdapter: RouterAdapter = {
      name: 'openrouter' as any,
      toUpstreamId: () => 'm',
      listModels: vi.fn(async () => []),
      chatCompletion: vi.fn(async () => ({
        status: 200,
        body: orSuccessBody,
        usage: { promptTokens: 1, completionTokens: 1, totalCost: null },
        providerCostUsd: null,
      })),
    };

    const adapters = new Map<string, RouterAdapter>([
      ['provider-primary', erAdapter],
      ['openrouter', orAdapter],
    ]);

    const redis = makeRedis(catalogEntry, [
      { name: 'openrouter', enabled: true },
      { name: 'provider-primary', enabled: true },
    ]);

    const ctx = {
      platformPool: makePoolStub(),
      runtimePool: makePoolStub(),
      redis,
      adapters,
      markupPct: 0, appId: 'a', userId: 'u', region: 'r',
    };

    const result = await routeChatCompletion(ctx as any, { model: 'm', messages: [{ role: 'user', content: 'hi' }] });

    // ER should have been tried first (presence mode), then OR as fallback
    expect(erAdapter.chatCompletion).toHaveBeenCalledTimes(1);
    expect(orAdapter.chatCompletion).toHaveBeenCalledTimes(1);
    expect(result.status).toBe(200);
  });
});

describe('nullable appId', () => {
  it('routeChatCompletion accepts appId: null and passes null to writeAiUsageRow', async () => {
    const { writeAiUsageRow } = await import('./usage-log.js');
    vi.mocked(writeAiUsageRow).mockClear();

    const catalogEntry = entry('openrouter');
    const adapter: RouterAdapter = {
      toUpstreamId: () => 'm',
      chatCompletion: vi.fn(async () => ({
        status: 200, body: { id: 'r', object: 'chat.completion', model: 'm', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
        usage: { promptTokens: 1, completionTokens: 1 },
      })),
    };

    const ctx = {
      platformPool: makePoolStub(),
      runtimePool: makePoolStub(),
      redis: makeRedis(catalogEntry, [{ name: 'openrouter', enabled: true }]),
      adapters: new Map([['openrouter', adapter]]),
      markupPct: 0, appId: null, userId: 'u', region: 'r',
    };

    const result = await routeChatCompletion(ctx as any, { model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    expect(result.status).toBe(200);

    // writeAiUsageRow should have been called with appId === null
    expect(vi.mocked(writeAiUsageRow)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ appId: null }),
    );
  });
});
