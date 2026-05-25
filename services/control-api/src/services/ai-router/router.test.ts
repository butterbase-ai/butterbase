import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { routeChatCompletion, routeVideoSubmit, routeVideoPoll, settleVideoJob, RouterError, wrapStreamForSettlement } from './router.js';
import { AdapterError, type RouterAdapter, type VideoGenerationRequest } from './adapters/types.js';
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
    expect(result.estimatedCostUsd).toBe(3.0); // no rawPricing on fixture → falls back to VIDEO_DEFAULT_ESTIMATE_USD
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

// ---------------------------------------------------------------------------
// estimateVideoCostUsd — tested indirectly through routeVideoSubmit
// ---------------------------------------------------------------------------

/**
 * Build a minimal video CatalogEntry with optional rawPricing pricing_skus.
 * The key is stored at routers[0].rawPricing.
 */
function videoEntryWithSkus(pricingSkus?: Record<string, string> | null, rawPricingOverride?: unknown) {
  const rawPricing = rawPricingOverride !== undefined
    ? rawPricingOverride
    : (pricingSkus !== null && pricingSkus !== undefined ? { pricing_skus: pricingSkus } : undefined);
  return {
    canonicalId: 'bytedance/seedance-2.0',
    displayName: 'Test Video Model',
    updatedAt: new Date().toISOString(),
    routers: [
      {
        name: 'openrouter',
        upstreamId: 'bytedance/seedance-2.0',
        promptPricePerMtok: 0,
        completionPricePerMtok: 0,
        contextLength: 0,
        modality: 'video' as const,
        ...(rawPricing !== undefined ? { rawPricing } : {}),
      },
    ],
  };
}

async function submitVideoWithEntry(entry: any, req: Partial<VideoGenerationRequest> = {}): Promise<number> {
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

  // Enable every router named in the entry so multi-router fixtures don't
  // get filtered out as "no available router."
  const enabledList = (entry?.routers ?? []).map((r: any) => ({ name: r.name, enabled: true }));
  const redis: any = {
    get: vi.fn(async (key: string) => {
      if (key === 'ai_catalog:model:bytedance/seedance-2.0') return JSON.stringify(entry);
      if (key === 'ai_catalog:routers') return JSON.stringify(
        enabledList.length > 0 ? enabledList : [{ name: 'openrouter', enabled: true }],
      );
      return null;
    }),
  };

  // Register a submitVideo stub for every router so the route handler can
  // pick whichever the ranker chose. They all return the same stub job —
  // the test asserts on the lease estimate, not on which router won.
  const adapters = new Map<string, RouterAdapter>();
  const routerNames: string[] = enabledList.length > 0
    ? enabledList.map((r: any) => r.name)
    : ['openrouter'];
  for (const name of routerNames) {
    adapters.set(name, { ...adapter, name: name as any });
  }

  const ctx: any = {
    platformPool: makePoolStub(),
    runtimePool: makePoolStub(),
    redis,
    adapters,
    markupPct: 0,
    appId: 'a',
    userId: 'u',
    region: 'r',
  };

  const result = await routeVideoSubmit(ctx, {
    model: 'bytedance/seedance-2.0',
    prompt: 'test',
    ...req,
  });
  return result.estimatedCostUsd;
}

describe('estimateVideoCostUsd (via routeVideoSubmit)', () => {
  it('1. Wan 2.6 4s: picks max rate $0.15 (1080p), duration=4 → $0.72', async () => {
    const entry = videoEntryWithSkus({
      text_to_video_duration_seconds_720p: '0.08',
      text_to_video_duration_seconds_1080p: '0.12',
      image_to_video_duration_seconds_1080p: '0.15',
    });
    const cost = await submitVideoWithEntry(entry, { duration: 4 });
    // max=0.15, 0.15*4*1.2 = 0.72, clamp(0.72, 0.05, 9) = 0.72
    expect(cost).toBeCloseTo(0.72, 10);
  });

  it('2. Veo 3.1 8s: max $0.60 (4k), duration=8 → $5.76', async () => {
    const entry = videoEntryWithSkus({
      duration_seconds_with_audio: '0.40',
      duration_seconds_with_audio_4k: '0.60',
      duration_seconds_without_audio: '0.20',
    });
    const cost = await submitVideoWithEntry(entry, { duration: 8 });
    // max=0.60, 0.60*8*1.2 = 5.76, clamp(5.76, 0.05, 9) = 5.76
    expect(cost).toBeCloseTo(5.76, 10);
  });

  it('3. Wan 2.7, no duration in request: max $0.10, defaults to 10s → $1.20', async () => {
    const entry = videoEntryWithSkus({
      duration_seconds: '0.1',
    });
    // no duration field → defaults to 10
    const cost = await submitVideoWithEntry(entry, {});
    // 0.1*10*1.2 = 1.2
    expect(cost).toBeCloseTo(1.2, 10);
  });

  it('4. Seedance token-based pricing (no duration_seconds SKUs) → falls back to VIDEO_DEFAULT_ESTIMATE_USD (3.0)', async () => {
    const entry = videoEntryWithSkus({
      video_tokens: '0.0000056',
    });
    const cost = await submitVideoWithEntry(entry, { duration: 5 });
    expect(cost).toBe(3.0);
  });

  it('5. No rawPricing on catalog entry → falls back to 3.0', async () => {
    const entry = videoEntryWithSkus(undefined);
    const cost = await submitVideoWithEntry(entry);
    expect(cost).toBe(3.0);
  });

  it('6. rawPricing is not an object (string) → falls back to 3.0', async () => {
    const entry = videoEntryWithSkus(undefined, 'invalid-string');
    const cost = await submitVideoWithEntry(entry);
    expect(cost).toBe(3.0);
  });

  it('7. All-zero rates in pricing_skus → falls back to 3.0', async () => {
    const entry = videoEntryWithSkus({
      duration_seconds: '0',
      duration_seconds_hd: '0.0',
    });
    const cost = await submitVideoWithEntry(entry);
    expect(cost).toBe(3.0);
  });

  it('8. Crazy SKU rate of $100/s → clamped to $9', async () => {
    const entry = videoEntryWithSkus({
      duration_seconds: '100',
    });
    const cost = await submitVideoWithEntry(entry, { duration: 10 });
    // 100*10*1.2 = 1200, clamped to 9
    expect(cost).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// estimateVideoCostUsd — ImaRouter unit:'second' shape
// ---------------------------------------------------------------------------

/**
 * Build a minimal video CatalogEntry with ImaRouter rawPricing shape.
 */
function videoEntryWithImaRouterPricing(
  variants: Array<{ spec: string; pricePerSecond: number }>,
  extraRawPricing?: Record<string, unknown>,
) {
  // Use 'openrouter' so submitVideoWithEntry's redis + adapter mocks match.
  // The router name is irrelevant for estimateVideoCostUsd; we're testing the
  // rawPricing shape interpretation only.
  const rawPricing = { unit: 'second', variants, ...extraRawPricing };
  return {
    canonicalId: 'bytedance/seedance-2.0',
    displayName: 'Test ImaRouter Video Model',
    updatedAt: new Date().toISOString(),
    routers: [
      {
        name: 'openrouter',
        upstreamId: 'bytedance/seedance-2.0',
        promptPricePerMtok: 0,
        completionPricePerMtok: 0,
        contextLength: 0,
        modality: 'video' as const,
        rawPricing,
      },
    ],
  };
}

describe('estimateVideoCostUsd — ImaRouter unit:second shape', () => {
  // Tests 3 & 4 (fallback cases) are separate `it()` blocks below — they assert
  // the VIDEO_DEFAULT_ESTIMATE_USD branch, which doesn't fit the input/expected
  // shape of this table.
  it.each([
    {
      label: '1. Happy path: picks max rate × duration × 1.2 within clamp',
      variants: [
        { spec: '720p', pricePerSecond: 0.05 },
        { spec: '1080p', pricePerSecond: 0.10 },
      ],
      duration: 5,
      // 0.10 * 5 * 1.2 = 0.60
      expected: 0.60,
    },
    {
      label: '2. Default duration (no req.duration) → uses 10s',
      variants: [{ spec: '1080p', pricePerSecond: 0.10 }],
      duration: undefined,
      // 0.10 * 10 * 1.2 = 1.20
      expected: 1.20,
    },
    {
      label: '5. High max rate clamped to $9',
      variants: [{ spec: '4k', pricePerSecond: 10.0 }],
      duration: 10,
      // 10 * 10 * 1.2 = 120, clamped to 9
      expected: 9,
    },
    {
      label: '6. Low max rate floored to $0.05',
      variants: [{ spec: '360p', pricePerSecond: 0.001 }],
      duration: 1,
      // 0.001 * 1 * 1.2 = 0.0012, floored to 0.05
      expected: 0.05,
    },
  ])('$label', async ({ variants, duration, expected }) => {
    const entry = videoEntryWithImaRouterPricing(variants);
    const req = duration !== undefined ? { duration } : {};
    const cost = await submitVideoWithEntry(entry, req);
    expect(cost).toBeCloseTo(expected, 10);
  });

  it('3. Empty variants array → falls back to VIDEO_DEFAULT_ESTIMATE_USD (3.0)', async () => {
    const entry = videoEntryWithImaRouterPricing([]);
    const cost = await submitVideoWithEntry(entry, { duration: 5 });
    expect(cost).toBe(3.0);
  });

  it('4. Variants with zero or non-finite rates all filtered → falls back to 3.0', async () => {
    const entry = videoEntryWithImaRouterPricing([
      { spec: '720p', pricePerSecond: 0 },
      { spec: '1080p', pricePerSecond: NaN },
      { spec: '4k', pricePerSecond: -1 },
    ]);
    const cost = await submitVideoWithEntry(entry, { duration: 5 });
    expect(cost).toBe(3.0);
  });

  it('8. Mixed: both pricing_skus AND unit:second present → pricing_skus wins', async () => {
    // pricing_skus says 0.10/s; ImaRouter variants say 0.50/s
    // pricing_skus branch should fire first and return 0.10*5*1.2 = 0.60
    const entry = videoEntryWithImaRouterPricing(
      [{ spec: '1080p', pricePerSecond: 0.50 }],
      { pricing_skus: { duration_seconds: '0.10' } },
    );
    const cost = await submitVideoWithEntry(entry, { duration: 5 });
    // pricing_skus: 0.10 * 5 * 1.2 = 0.60 (not 0.50*5*1.2=3.0)
    expect(cost).toBeCloseTo(0.60, 10);
  });

  // ─── Per-request resolution + visualInput matching ────────────────────────
  //
  // Token360 seedance pricing: text-only vs visual-input × {480p, 720p, 1080p}.
  // The estimator picks the variant matching the request's resolution +
  // (input_images || input_references).
  describe('resolution + visualInput matching', () => {
    const tieredVariants = [
      { spec: '480p',  visualInput: false, pricePerSecond: 0.07 },
      { spec: '720p',  visualInput: false, pricePerSecond: 0.16 },
      { spec: '1080p', visualInput: false, pricePerSecond: 0.35 },
      { spec: '480p',  visualInput: true,  pricePerSecond: 0.04 },
      { spec: '720p',  visualInput: true,  pricePerSecond: 0.10 },
      { spec: '1080p', visualInput: true,  pricePerSecond: 0.22 },
    ];

    it('text-only 720p picks text 720p rate, not 1080p text or visual', async () => {
      const entry = videoEntryWithImaRouterPricing(tieredVariants as any);
      const cost = await submitVideoWithEntry(entry, { duration: 5, resolution: '720p' });
      // 0.16 * 5 * 1.2 = 0.96
      expect(cost).toBeCloseTo(0.96, 10);
    });

    it('visual-input 480p (input_images present) picks visual 480p rate', async () => {
      const entry = videoEntryWithImaRouterPricing(tieredVariants as any);
      const cost = await submitVideoWithEntry(entry, {
        duration: 5, resolution: '480p', input_images: ['https://e/x.png'],
      });
      // 0.04 * 5 * 1.2 = 0.24
      expect(cost).toBeCloseTo(0.24, 10);
    });

    it('visual-input via input_references (no input_images) still routes to visual rate', async () => {
      const entry = videoEntryWithImaRouterPricing(tieredVariants as any);
      const cost = await submitVideoWithEntry(entry, {
        duration: 5, resolution: '1080p', input_references: ['https://e/r.png'],
      });
      // 0.22 * 5 * 1.2 = 1.32
      expect(cost).toBeCloseTo(1.32, 10);
    });

    it('legacy variants (no visualInput flag) still match by resolution only', async () => {
      const entry = videoEntryWithImaRouterPricing([
        { spec: '720p',  pricePerSecond: 0.16 },
        { spec: '1080p', pricePerSecond: 0.35 },
      ]);
      const cost = await submitVideoWithEntry(entry, {
        duration: 5, resolution: '720p', input_images: ['https://e/x.png'],
      });
      // 0.16 * 5 * 1.2 = 0.96 — visualInput filter is dropped, resolution still wins
      expect(cost).toBeCloseTo(0.96, 10);
    });

    it('no req.resolution + visual input → max across visual variants only', async () => {
      const entry = videoEntryWithImaRouterPricing(tieredVariants as any);
      const cost = await submitVideoWithEntry(entry, {
        duration: 5, input_images: ['https://e/x.png'],
      });
      // max visual rate = 0.22; 0.22 * 5 * 1.2 = 1.32
      expect(cost).toBeCloseTo(1.32, 10);
    });

    it('no req.resolution + text-only → max across text variants', async () => {
      const entry = videoEntryWithImaRouterPricing(tieredVariants as any);
      const cost = await submitVideoWithEntry(entry, { duration: 5 });
      // max text rate = 0.35; 0.35 * 5 * 1.2 = 2.1
      expect(cost).toBeCloseTo(2.1, 10);
    });

    it('unknown resolution (no variant matches spec) → full fallback to max-rate', async () => {
      const entry = videoEntryWithImaRouterPricing(tieredVariants as any);
      const cost = await submitVideoWithEntry(entry, { duration: 5, resolution: '4k' });
      // No match — falls all the way back to max across all variants = 0.35
      // 0.35 * 5 * 1.2 = 2.1
      expect(cost).toBeCloseTo(2.1, 10);
    });

    it('resolution match exists for text but request is visual → resolution-only fallback', async () => {
      // Only text variants for 1080p, only visual for 480p — request 1080p visual.
      const entry = videoEntryWithImaRouterPricing([
        { spec: '1080p', visualInput: false, pricePerSecond: 0.35 },
        { spec: '480p',  visualInput: true,  pricePerSecond: 0.04 },
      ] as any);
      const cost = await submitVideoWithEntry(entry, {
        duration: 5, resolution: '1080p', input_images: ['https://e/x.png'],
      });
      // Step 1 (exact res+visual): no match. Step 2 (res only): 0.35. → 2.1
      expect(cost).toBeCloseTo(2.1, 10);
    });
  });

  // ─── Multi-router scan ──────────────────────────────────────────────────
  //
  // Regression: estimator used to read entry.routers[0].rawPricing only, so
  // when openrouter (which has no per-second variants for seedance) was
  // refresh-ordered first, the call silently returned VIDEO_DEFAULT_ESTIMATE_USD.
  describe('multi-router rawPricing scan', () => {
    it('falls back to a sibling router with usable rawPricing when routers[0] has none', async () => {
      const entry = {
        canonicalId: 'bytedance/seedance-2.0',
        displayName: 'mixed',
        updatedAt: new Date().toISOString(),
        routers: [
          // openrouter: chat-shaped, no per-second variants
          { name: 'openrouter' as any, upstreamId: 'x', promptPricePerMtok: 0, completionPricePerMtok: 0, contextLength: 0, modality: 'video' as const },
          // provider-tertiary: usable per-second pricing
          { name: 'provider-tertiary' as any, upstreamId: 'x', promptPricePerMtok: 0, completionPricePerMtok: 0, contextLength: 0, modality: 'video' as const,
            rawPricing: { unit: 'second', variants: [
              { spec: '720p', visualInput: false, pricePerSecond: 0.16 },
            ] } },
        ],
      };
      const cost = await submitVideoWithEntry(entry, { duration: 5, resolution: '720p' });
      // 0.16 * 5 * 1.2 = 0.96 — NOT the $3 default
      expect(cost).toBeCloseTo(0.96, 10);
    });

    it('takes the MAX rate across routers (worst-case lease)', async () => {
      const entry = {
        canonicalId: 'bytedance/seedance-2.0',
        displayName: 'mixed',
        updatedAt: new Date().toISOString(),
        routers: [
          { name: 'provider-secondary' as any, upstreamId: 'x', promptPricePerMtok: 0, completionPricePerMtok: 0, contextLength: 0, modality: 'video' as const,
            rawPricing: { unit: 'second', variants: [{ spec: '720p', pricePerSecond: 0.10 }] } },
          { name: 'provider-tertiary' as any, upstreamId: 'x', promptPricePerMtok: 0, completionPricePerMtok: 0, contextLength: 0, modality: 'video' as const,
            rawPricing: { unit: 'second', variants: [{ spec: '720p', pricePerSecond: 0.20 }] } },
        ],
      };
      const cost = await submitVideoWithEntry(entry, { duration: 5, resolution: '720p' });
      // Max rate 0.20 wins: 0.20 * 5 * 1.2 = 1.20
      expect(cost).toBeCloseTo(1.20, 10);
    });

    it('returns VIDEO_DEFAULT_ESTIMATE_USD only when ALL routers lack pricing', async () => {
      const entry = {
        canonicalId: 'bytedance/seedance-2.0',
        displayName: 'no pricing',
        updatedAt: new Date().toISOString(),
        routers: [
          { name: 'openrouter' as any, upstreamId: 'x', promptPricePerMtok: 0, completionPricePerMtok: 0, contextLength: 0, modality: 'video' as const },
          { name: 'provider-secondary' as any, upstreamId: 'x', promptPricePerMtok: 0, completionPricePerMtok: 0, contextLength: 0, modality: 'video' as const },
        ],
      };
      const cost = await submitVideoWithEntry(entry, { duration: 5 });
      expect(cost).toBe(3.0);
    });
  });
});

// ---------------------------------------------------------------------------
// billedVideoCostUsd — settle-time variant
// ---------------------------------------------------------------------------

describe('billedVideoCostUsd', () => {
  const entry = {
    canonicalId: 'bytedance/seedance-2.0',
    displayName: 'seedance',
    updatedAt: new Date().toISOString(),
    routers: [
      // provider-secondary: cheaper, would win on max-rate scan
      { name: 'provider-secondary' as any, upstreamId: 'x', promptPricePerMtok: 0, completionPricePerMtok: 0, contextLength: 0, modality: 'video' as const,
        rawPricing: { unit: 'second', variants: [
          { spec: '480p', pricePerSecond: 0.09 },
        ] } },
      // provider-tertiary: chosen router, has per-mode pricing
      { name: 'provider-tertiary' as any, upstreamId: 'x', promptPricePerMtok: 0, completionPricePerMtok: 0, contextLength: 0, modality: 'video' as const,
        rawPricing: { unit: 'second', variants: [
          { spec: '480p', visualInput: false, pricePerSecond: 0.071039 },
          { spec: '720p', visualInput: false, pricePerSecond: 0.157500 },
        ] } },
    ],
  };

  it('pins to the chosen router (provider-tertiary), does NOT apply the lease buffer', async () => {
    const { billedVideoCostUsd } = await import('./router.js');
    const cost = billedVideoCostUsd(entry as any, { model: 'x', prompt: 'p', duration: 4, resolution: '480p' }, 'provider-tertiary' as any);
    // 0.071039 * 4 = 0.284156 (no 1.2× buffer, clamped above floor 0.05)
    expect(cost).toBeCloseTo(0.284156, 6);
  });

  it('uses higher tier when resolution = 720p (text mode)', async () => {
    const { billedVideoCostUsd } = await import('./router.js');
    const cost = billedVideoCostUsd(entry as any, { model: 'x', prompt: 'p', duration: 5, resolution: '720p' }, 'provider-tertiary' as any);
    // 0.157500 * 5 = 0.7875
    expect(cost).toBeCloseTo(0.7875, 6);
  });

  it('falls back to sibling router pricing when chosen router has none', async () => {
    const { billedVideoCostUsd } = await import('./router.js');
    const e = {
      ...entry,
      routers: [
        // chosen router has no usable pricing
        { name: 'provider-tertiary' as any, upstreamId: 'x', promptPricePerMtok: 0, completionPricePerMtok: 0, contextLength: 0, modality: 'video' as const },
        { name: 'provider-secondary' as any, upstreamId: 'x', promptPricePerMtok: 0, completionPricePerMtok: 0, contextLength: 0, modality: 'video' as const,
          rawPricing: { unit: 'second', variants: [{ spec: '480p', pricePerSecond: 0.09 }] } },
      ],
    };
    const cost = billedVideoCostUsd(e as any, { model: 'x', prompt: 'p', duration: 4, resolution: '480p' }, 'provider-tertiary' as any);
    // 0.09 * 4 = 0.36
    expect(cost).toBeCloseTo(0.36, 6);
  });

  it('returns null when no router has parseable pricing', async () => {
    const { billedVideoCostUsd } = await import('./router.js');
    const e = {
      ...entry,
      routers: [
        { name: 'provider-tertiary' as any, upstreamId: 'x', promptPricePerMtok: 0, completionPricePerMtok: 0, contextLength: 0, modality: 'video' as const },
      ],
    };
    const cost = billedVideoCostUsd(e as any, { model: 'x', prompt: 'p' }, 'provider-tertiary' as any);
    expect(cost).toBeNull();
  });

  it('floor of $0.05 is applied even at settle time', async () => {
    const { billedVideoCostUsd } = await import('./router.js');
    const e = {
      ...entry,
      routers: [
        { name: 'provider-tertiary' as any, upstreamId: 'x', promptPricePerMtok: 0, completionPricePerMtok: 0, contextLength: 0, modality: 'video' as const,
          rawPricing: { unit: 'second', variants: [{ spec: '480p', pricePerSecond: 0.001 }] } },
      ],
    };
    const cost = billedVideoCostUsd(e as any, { model: 'x', prompt: 'p', duration: 1, resolution: '480p' }, 'provider-tertiary' as any);
    expect(cost).toBe(0.05);
  });
});

describe('wrapStreamForSettlement', () => {
  // Regression: the SSE parser used to read `parsed.usage.total_cost`, but
  // OpenRouter sends `parsed.usage.cost`. The settlement callback got null
  // every time and the router fell back to a catalog-token estimate.
  it('extracts cost from streamed usage.cost (OpenRouter wire format)', async () => {
    const enc = new TextEncoder();
    const chunks = [
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      'data: {"usage":{"prompt_tokens":10,"completion_tokens":1299,"cost":0.0387255}}\n\n',
      'data: [DONE]\n\n',
    ];
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(enc.encode(c));
        controller.close();
      },
    });
    let captured: { promptTokens: number; completionTokens: number; cost: number | null } | null = null;
    const wrapped = wrapStreamForSettlement(upstream, async (usage, providerCost) => {
      captured = { ...usage, cost: providerCost };
    });
    // Drain the wrapped stream to trigger the onComplete callback.
    const reader = wrapped.getReader();
    while (!(await reader.read()).done) { /* drain */ }
    expect(captured).toEqual({ promptTokens: 10, completionTokens: 1299, cost: 0.0387255 });
  });

  it('still reads legacy total_cost when cost is absent', async () => {
    const enc = new TextEncoder();
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode(
          'data: {"usage":{"prompt_tokens":1,"completion_tokens":2,"total_cost":0.005}}\n\ndata: [DONE]\n\n'
        ));
        controller.close();
      },
    });
    let cost: number | null = -1;
    const wrapped = wrapStreamForSettlement(upstream, async (_u, c) => { cost = c; });
    const reader = wrapped.getReader();
    while (!(await reader.read()).done) { /* drain */ }
    expect(cost).toBe(0.005);
  });
});
