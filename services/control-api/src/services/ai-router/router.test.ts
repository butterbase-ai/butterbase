import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { routeChatCompletion, routeVideoSubmit, routeVideoPoll, settleVideoJob, RouterError } from './router.js';
import { AdapterError, type RouterAdapter } from './adapters/types.js';
import { applyMarkup } from './markup.js';

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

// ---------------------------------------------------------------------------
// Helper: build a CatalogEntry for a video model
// ---------------------------------------------------------------------------
function videoEntry(routerName: string) {
  return {
    canonicalId: 'bytedance/seedance-2.0',
    displayName: 'Seedance 2.0',
    updatedAt: new Date().toISOString(),
    routers: [
      {
        name: routerName,
        upstreamId: 'bytedance/seedance-2.0',
        promptPricePerMtok: 0,
        completionPricePerMtok: 0,
        contextLength: 0,
        modality: 'video' as const,
      },
    ],
  };
}

function makeVideoRedis(catalogEntry: any, routers: any[]) {
  return {
    get: vi.fn(async (key: string) => {
      if (key === 'ai_catalog:model:bytedance/seedance-2.0') return JSON.stringify(catalogEntry);
      if (key === 'ai_catalog:routers') return JSON.stringify(routers);
      return null;
    }),
  } as any;
}

describe('routeVideoSubmit', () => {
  it('happy path: calls submitVideo and returns job details', async () => {
    const submitVideo = vi.fn(async () => ({
      upstreamJobId: 'job-xyz',
      pollingUrl: 'https://openrouter.ai/api/v1/videos/job-xyz',
      status: 'pending' as const,
    }));

    const adapter: RouterAdapter = {
      name: 'openrouter' as any,
      toUpstreamId: (id: string) => id,
      listModels: vi.fn(async () => []),
      chatCompletion: vi.fn(async () => ({ status: 200, body: {}, usage: null, providerCostUsd: null })),
      submitVideo,
    };

    const catalogEntry = videoEntry('openrouter');
    const redis = makeVideoRedis(catalogEntry, [{ name: 'openrouter', enabled: true }]);

    const ctx = {
      platformPool: makePoolStub(),
      runtimePool: makePoolStub(),
      redis,
      adapters: new Map([['openrouter', adapter]]),
      markupPct: 0,
      appId: 'a',
      userId: 'u',
      region: 'r',
    };

    const result = await routeVideoSubmit(ctx as any, {
      model: 'bytedance/seedance-2.0',
      prompt: 'a cat on a piano',
    });

    expect(result.upstreamJobId).toBe('job-xyz');
    expect(result.pollingUrl).toBe('https://openrouter.ai/api/v1/videos/job-xyz');
    expect(result.chosenRouter).toBe('openrouter');
    expect(result.leaseId).toBeTruthy();
    expect(result.estimatedCostUsd).toBe(0.5);
    expect(submitVideo).toHaveBeenCalledTimes(1);
  });

  it('lease-refund-on-failure: rejects with ROUTER_FALLBACK_EXHAUSTED and refunds lease', async () => {
    const { settleAfterCall } = await import('./billing-gate.js');
    vi.mocked(settleAfterCall).mockClear();

    // Adapter without submitVideo — triggers fallback exhaustion
    const adapter: RouterAdapter = {
      name: 'openrouter' as any,
      toUpstreamId: (id: string) => id,
      listModels: vi.fn(async () => []),
      chatCompletion: vi.fn(async () => ({ status: 200, body: {}, usage: null, providerCostUsd: null })),
      // submitVideo intentionally omitted
    };

    const catalogEntry = videoEntry('openrouter');
    const redis = makeVideoRedis(catalogEntry, [{ name: 'openrouter', enabled: true }]);

    const ctx = {
      platformPool: makePoolStub(),
      runtimePool: makePoolStub(),
      redis,
      adapters: new Map([['openrouter', adapter]]),
      markupPct: 0,
      appId: 'a',
      userId: 'u',
      region: 'r',
    };

    await expect(
      routeVideoSubmit(ctx as any, { model: 'bytedance/seedance-2.0', prompt: 'a cat on a piano' }),
    ).rejects.toMatchObject({ code: 'ROUTER_FALLBACK_EXHAUSTED' });

    // settleAfterCall should have been called with 0 to refund the lease
    expect(vi.mocked(settleAfterCall)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ leaseId: 'lease-1' }),
      0,
    );
  });
});

describe('routeVideoPoll', () => {
  it('happy path: returns poll result from adapter', async () => {
    const pollVideo = vi.fn(async () => ({
      status: 'completed' as const,
      unsignedUrls: ['https://cdn.openrouter.ai/videos/job-xyz.mp4'],
      providerCostUsd: 0.25,
    }));

    const adapter: RouterAdapter = {
      name: 'openrouter' as any,
      toUpstreamId: (id: string) => id,
      listModels: vi.fn(async () => []),
      chatCompletion: vi.fn(async () => ({ status: 200, body: {}, usage: null, providerCostUsd: null })),
      pollVideo,
    };

    const ctx = {
      platformPool: makePoolStub(),
      runtimePool: makePoolStub(),
      redis: { get: vi.fn(async () => null) } as any,
      adapters: new Map([['openrouter', adapter]]),
      markupPct: 0,
      appId: 'a',
      userId: 'u',
      region: 'r',
    };

    const result = await routeVideoPoll(
      ctx as any,
      'openrouter' as any,
      'https://openrouter.ai/api/v1/videos/job-xyz',
    );

    expect(result.status).toBe('completed');
    expect(result.unsignedUrls).toEqual(['https://cdn.openrouter.ai/videos/job-xyz.mp4']);
    expect(result.providerCostUsd).toBe(0.25);
    expect(pollVideo).toHaveBeenCalledTimes(1);
    expect(pollVideo).toHaveBeenCalledWith('https://openrouter.ai/api/v1/videos/job-xyz');
  });

  it('throws NO_ROUTERS_AVAILABLE when adapter lacks pollVideo', async () => {
    const adapter: RouterAdapter = {
      name: 'openrouter' as any,
      toUpstreamId: (id: string) => id,
      listModels: vi.fn(async () => []),
      chatCompletion: vi.fn(async () => ({ status: 200, body: {}, usage: null, providerCostUsd: null })),
      // pollVideo intentionally omitted
    };

    const ctx = {
      platformPool: makePoolStub(),
      runtimePool: makePoolStub(),
      redis: { get: vi.fn(async () => null) } as any,
      adapters: new Map([['openrouter', adapter]]),
      markupPct: 0,
      appId: 'a',
      userId: 'u',
      region: 'r',
    };

    await expect(
      routeVideoPoll(ctx as any, 'openrouter' as any, 'https://openrouter.ai/api/v1/videos/job-xyz'),
    ).rejects.toMatchObject({ code: 'NO_ROUTERS_AVAILABLE' });
  });
});

describe('routeVideoSubmit wrong-modality', () => {
  it('throws WRONG_MODALITY when called with a non-video model', async () => {
    // A chat model — no routers have modality: 'video'
    const chatEntry = {
      canonicalId: 'bytedance/seedance-2.0',
      displayName: 'some-chat-model',
      updatedAt: new Date().toISOString(),
      routers: [
        {
          name: 'openrouter',
          upstreamId: 'bytedance/seedance-2.0',
          promptPricePerMtok: 1,
          completionPricePerMtok: 1,
          contextLength: 4096,
          modality: 'chat' as const,
        },
      ],
    };

    const redis = makeVideoRedis(chatEntry, [{ name: 'openrouter', enabled: true }]);

    const ctx = {
      platformPool: makePoolStub(),
      runtimePool: makePoolStub(),
      redis,
      adapters: new Map(),
      markupPct: 0,
      appId: 'a',
      userId: 'u',
      region: 'r',
    };

    await expect(
      routeVideoSubmit(ctx as any, { model: 'bytedance/seedance-2.0', prompt: 'a cat' }),
    ).rejects.toMatchObject({ code: 'WRONG_MODALITY', statusCode: 400 });
  });
});

describe('settleVideoJob', () => {
  it('applies markup, calls settleAfterCall, writes usage row, returns charged credits', async () => {
    const { settleAfterCall } = await import('./billing-gate.js');
    const { writeAiUsageRow } = await import('./usage-log.js');
    vi.mocked(settleAfterCall).mockClear();
    vi.mocked(writeAiUsageRow).mockClear();

    const ctx = {
      platformPool: makePoolStub(),
      runtimePool: makePoolStub(),
      redis: { get: vi.fn(async () => null) } as any,
      adapters: new Map(),
      markupPct: 20,
      appId: 'a',
      userId: 'u',
      region: 'r',
    };

    const providerCostUsd = 0.25;
    const expectedCharged = applyMarkup(providerCostUsd, 20);

    const result = await settleVideoJob(ctx as any, {
      leaseId: 'lease-1',
      chosenRouter: 'openrouter' as any,
      canonicalModel: 'bytedance/seedance-2.0',
      providerCostUsd,
    });

    // settleAfterCall called with synthetic handle containing leaseId
    expect(vi.mocked(settleAfterCall)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ leaseId: 'lease-1' }),
      expectedCharged,
    );

    // writeAiUsageRow called with correct fields
    expect(vi.mocked(writeAiUsageRow)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        model: 'bytedance/seedance-2.0',
        router: 'openrouter',
        providerCostUsd: 0.25,
        chargedCreditsUsd: expectedCharged,
        leaseId: 'lease-1',
        keyType: 'platform',
        chargedToUser: true,
      }),
    );

    // returned shape
    expect(result).toEqual({
      chargedCreditsUsd: expectedCharged,
      providerCostUsd: 0.25,
    });
  });
});
