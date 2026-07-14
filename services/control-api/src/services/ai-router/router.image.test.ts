import { describe, it, expect, vi } from 'vitest';
import {
  routeImageSubmit,
  estimateImageCostUsd,
  billedImageCostUsd,
} from './router.js';
import { type RouterAdapter, type ImageGenerationRequest } from './adapters/types.js';
import type { CatalogEntry } from './catalog.js';

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

function makePoolStub() {
  return {
    connect: vi.fn(async () => ({
      query: vi.fn(async () => ({ rows: [{ user_id: 'u', credits_usd: '100', amount_usd: '100', status: 'active' }] })),
      release: vi.fn(),
    })),
    query: vi.fn(async () => ({ rows: [] })),
  } as any;
}

function imageEntry(
  routerName: string,
  rawPricing?: unknown,
  modality: 'image' | 'chat' = 'image',
): CatalogEntry {
  return {
    canonicalId: 'stability/sd3.5',
    displayName: 'Stable Diffusion 3.5',
    updatedAt: new Date().toISOString(),
    routers: [
      {
        name: routerName as any,
        upstreamId: 'stability/sd3.5',
        promptPricePerMtok: 0,
        completionPricePerMtok: 0,
        contextLength: 0,
        modality,
        rawPricing,
      },
    ],
  };
}

function makeImageRedis(catalogEntry: CatalogEntry | null, routers: any[]) {
  return {
    get: vi.fn(async (key: string) => {
      if (key === 'ai_catalog:model:stability/sd3.5') {
        return catalogEntry ? JSON.stringify(catalogEntry) : null;
      }
      if (key === 'ai_catalog:routers') return JSON.stringify(routers);
      return null;
    }),
    // readDownSlots issues an MGET across KNOWN_ROUTER_SLOTS; no slots are
    // ever down in these fixtures, so an all-null reply is sufficient.
    mget: vi.fn(async (...keys: string[]) => keys.map(() => null)),
  } as any;
}

function makeCtx(overrides: Partial<{ redis: any; adapters: Map<string, RouterAdapter> }> = {}) {
  return {
    platformPool: makePoolStub(),
    runtimePool: makePoolStub(),
    redis: overrides.redis ?? makeImageRedis(null, []),
    adapters: overrides.adapters ?? new Map(),
    markupPct: 0,
    appId: 'a',
    organizationId: 'org-1',
    userId: 'u',
    region: 'r',
  };
}

function baseAdapter(overrides: Partial<RouterAdapter> = {}): RouterAdapter {
  return {
    name: 'openrouter' as any,
    toUpstreamId: (id: string) => id,
    listModels: vi.fn(async () => []),
    chatCompletion: vi.fn(async () => ({ status: 200, body: {}, usage: null, providerCostUsd: null })),
    ...overrides,
  };
}

const VARIANTS = [
  { spec: '1024x1024', pricePerImage: 0.04 },
  { spec: '1792x1024', pricePerImage: 0.08 },
];

describe('routeImageSubmit', () => {
  it('throws WRONG_MODALITY when the catalog entry has no image-modality router', async () => {
    const chatEntry = imageEntry('openrouter', undefined, 'chat');
    const redis = makeImageRedis(chatEntry, [{ name: 'openrouter', enabled: true }]);
    const ctx = makeCtx({ redis, adapters: new Map([['openrouter', baseAdapter({ submitImage: vi.fn() })]]) });

    await expect(
      routeImageSubmit(ctx as any, { model: 'stability/sd3.5', prompt: 'a fox' }),
    ).rejects.toMatchObject({ code: 'WRONG_MODALITY', statusCode: 400 });
  });

  it('throws MODEL_NOT_FOUND when the catalog entry is missing', async () => {
    const redis = makeImageRedis(null, []);
    const ctx = makeCtx({ redis });

    await expect(
      routeImageSubmit(ctx as any, { model: 'stability/sd3.5', prompt: 'a fox' }),
    ).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND', statusCode: 404 });
  });

  it('refunds the lease when adapter.submitImage throws a non-fallback error', async () => {
    const { settleAfterCall } = await import('./billing-gate.js');
    vi.mocked(settleAfterCall).mockClear();

    const boom = new Error('upstream exploded');
    const submitImage = vi.fn(async () => { throw boom; });
    const catalogEntry = imageEntry('openrouter', { variants: VARIANTS });
    const redis = makeImageRedis(catalogEntry, [{ name: 'openrouter', enabled: true }]);
    const ctx = makeCtx({ redis, adapters: new Map([['openrouter', baseAdapter({ submitImage })]]) });

    await expect(
      routeImageSubmit(ctx as any, { model: 'stability/sd3.5', prompt: 'a fox' }),
    ).rejects.toBe(boom);

    expect(vi.mocked(settleAfterCall)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ leaseId: 'lease-1' }),
      0,
    );
  });

  it('populates terminalInline when the adapter returns a terminal status on submit (OpenRouter-style)', async () => {
    const submitImage = vi.fn(async () => ({
      upstreamJobId: 'job-1',
      pollingUrl: 'https://openrouter.ai/api/v1/images/job-1',
      status: 'completed' as const,
      unsignedUrls: ['https://cdn.example.com/job-1.png'],
      contentType: 'image/png',
      providerCostUsd: 0.04,
    }));
    const catalogEntry = imageEntry('openrouter', { variants: VARIANTS });
    const redis = makeImageRedis(catalogEntry, [{ name: 'openrouter', enabled: true }]);
    const ctx = makeCtx({ redis, adapters: new Map([['openrouter', baseAdapter({ submitImage })]]) });

    const result = await routeImageSubmit(ctx as any, { model: 'stability/sd3.5', prompt: 'a fox', size: '1024x1024' });

    expect(result.terminalInline).toEqual({
      status: 'completed',
      unsignedUrls: ['https://cdn.example.com/job-1.png'],
      contentType: 'image/png',
      providerCostUsd: 0.04,
      error: undefined,
    });
    expect(result.chosenRouter).toBe('openrouter');
    expect(result.upstreamJobId).toBe('job-1');
  });

  it('returns terminalInline: null when the adapter returns a pending status (ImaRouter-style async path)', async () => {
    const submitImage = vi.fn(async () => ({
      upstreamJobId: 'job-2',
      pollingUrl: 'https://imarouter.example.com/jobs/job-2',
      status: 'pending' as const,
    }));
    const catalogEntry = imageEntry('provider-primary', { variants: VARIANTS });
    const redis = makeImageRedis(catalogEntry, [{ name: 'provider-primary', enabled: true }]);
    const ctx = makeCtx({ redis, adapters: new Map([['provider-primary', baseAdapter({ name: 'provider-primary' as any, submitImage })]]) });

    const result = await routeImageSubmit(ctx as any, { model: 'stability/sd3.5', prompt: 'a fox' });

    expect(result.terminalInline).toBeNull();
    expect(result.pollingUrl).toBe('https://imarouter.example.com/jobs/job-2');
  });
});

describe('estimateImageCostUsd', () => {
  const entry = imageEntry('openrouter', { variants: VARIANTS });

  it('picks the exact variant when req.size matches a spec', () => {
    const req: ImageGenerationRequest = { model: 'stability/sd3.5', prompt: 'x', size: '1792x1024' };
    expect(estimateImageCostUsd(entry, req)).toBe(0.08);
  });

  it('falls back to max(pricePerImage) when req.size matches nothing', () => {
    const req: ImageGenerationRequest = { model: 'stability/sd3.5', prompt: 'x', size: '4096x4096' };
    expect(estimateImageCostUsd(entry, req)).toBe(0.08);
  });

  it('falls back to max(pricePerImage) when req.size is unset', () => {
    const req: ImageGenerationRequest = { model: 'stability/sd3.5', prompt: 'x' };
    expect(estimateImageCostUsd(entry, req)).toBe(0.08);
  });

  it('multiplies by n when set', () => {
    const req: ImageGenerationRequest = { model: 'stability/sd3.5', prompt: 'x', size: '1024x1024', n: 3 };
    expect(estimateImageCostUsd(entry, req)).toBe(0.12);
  });

  it('treats n: 0 as zero images (no cost)', () => {
    const req: ImageGenerationRequest = { model: 'stability/sd3.5', prompt: 'x', size: '1024x1024', n: 0 };
    expect(estimateImageCostUsd(entry, req)).toBe(0);
  });

  it('returns 0 when no router has parseable variant pricing', () => {
    const bareEntry = imageEntry('openrouter', undefined);
    const req: ImageGenerationRequest = { model: 'stability/sd3.5', prompt: 'x' };
    expect(estimateImageCostUsd(bareEntry, req)).toBe(0);
  });
});

describe('billedImageCostUsd', () => {
  it('returns null when no variant matches (caller uses $0 guard)', () => {
    const entry = imageEntry('openrouter', undefined);
    const req: ImageGenerationRequest = { model: 'stability/sd3.5', prompt: 'x', size: '1024x1024' };
    expect(billedImageCostUsd(entry, req, 'openrouter' as any)).toBeNull();
  });

  it('pins to the chosen router pricing and multiplies by n', () => {
    const entry = imageEntry('openrouter', { variants: VARIANTS });
    const req: ImageGenerationRequest = { model: 'stability/sd3.5', prompt: 'x', size: '1024x1024', n: 2 };
    expect(billedImageCostUsd(entry, req, 'openrouter' as any)).toBe(0.08);
  });
});
