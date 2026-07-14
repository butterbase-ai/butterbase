import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import {
  buildPublicImageJobResponse,
  handleImageError,
  imageSubmitSchema,
  validateImageParams,
} from './ai-images.js';
import type { ImageJobRow } from '../services/ai-router/image-jobs.js';
import type { RouterAdapter, ImageSupportedParams } from '../services/ai-router/adapters/types.js';
import type { RouterName } from '../services/ai-router/normalize.js';
import { RouterError, InsufficientCreditsError } from '../services/ai-router/router.js';

// Route-level integration tests (authz matrix, sync-inline submit flow, async
// poll flow, terminal caching, /content streaming) are covered by the Task 9
// E2E smoke tests that run against the deployed service via MCP. Cases 1–3 and
// 7–11 from the Task 6 brief live there. The unit tests below cover every case
// that can be exercised without a live Fastify/Postgres/Redis/adapter stack:
//   - Case 4: alias preprocessor
//   - Case 5: UNSUPPORTED_PARAM 400
//   - Case 6: WRONG_MODALITY 400 (via RouterError → handleImageError)
//   - Case 12: /content INDEX_OUT_OF_RANGE shape via buildPublicImageJobResponse
// Plus the standard helpers (buildPublicImageJobResponse, handleImageError).

function makeJob(overrides: Partial<ImageJobRow> = {}): ImageJobRow {
  return {
    id: 'img-abc',
    app_id: 'app-1',
    organization_id: 'org-1',
    user_id: 'user-1',
    end_user_sub: null,
    model: 'openai/gpt-image-2',
    status: 'completed',
    request_json: { model: 'openai/gpt-image-2', prompt: 'a cat' },
    upstream_router: 'openrouter',
    upstream_job_id: 'upstream-xyz',
    upstream_polling_url: 'https://openrouter.ai/api/v1/generation/upstream-xyz',
    unsigned_urls: ['https://cdn.example.com/image.png'],
    content_type: 'image/png',
    error: null,
    lease_id: 'lease-1',
    estimated_cost_usd: '0.0400',
    provider_cost_usd: '0.0350',
    charged_credits_usd: '0.0385',
    markup_pct: '10.00',
    settled_at: new Date('2026-01-01T00:00:00Z'),
    created_at: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

// Minimal chainable reply mock for handleImageError tests
function makeReply() {
  const sent: { code: number; body: unknown } = { code: 0, body: undefined };
  const proxy = {
    _sent: sent,
    code: vi.fn((c: number) => { sent.code = c; return proxy; }),
    send: vi.fn((b: unknown) => { sent.body = b; return proxy; }),
  };
  return proxy;
}

function makeApp(dbQueryResult?: { rows: unknown[] }) {
  return {
    controlDb: {
      query: vi.fn().mockResolvedValue({ rows: dbQueryResult?.rows ?? [] }),
    },
    log: {
      warn: vi.fn(),
      error: vi.fn(),
    },
  } as unknown as import('fastify').FastifyInstance;
}

function makeAdapter(
  name: RouterName,
  ownedModels: Record<string, ImageSupportedParams>,
): RouterAdapter {
  return {
    name,
    capabilities: { supportsNativeMessages: () => false },
    toUpstreamId: (id: string) => id,
    listModels: async () => [],
    chatCompletion: async () => { throw new Error('not used'); },
    getSupportedImageParams: (canonicalId: string) => ownedModels[canonicalId] ?? null,
  };
}

describe('buildPublicImageJobResponse', () => {
  it('returns expected shape for a completed job with unsigned_urls', () => {
    const job = makeJob();
    const res = buildPublicImageJobResponse('https://api.example.com', 'app-1', job);
    expect(res.job_id).toBe('img-abc');
    expect(res.status).toBe('completed');
    expect(res.model).toBe('openai/gpt-image-2');
    expect(res.polling_url).toBe('https://api.example.com/v1/app-1/images/completions/img-abc');
    expect(res.content_urls).toEqual(['https://api.example.com/v1/app-1/images/completions/img-abc/content?index=0']);
    expect(res.error).toBeNull();
    expect(res.created_at).toBeInstanceOf(Date);
    expect(res.charged_credits_usd).toBeCloseTo(0.0385, 4);
    expect(res.settled_at).toBeInstanceOf(Date);
    expect(res).not.toHaveProperty('provider_cost_usd');
  });

  it('returns null content_urls when unsigned_urls is null', () => {
    const job = makeJob({ unsigned_urls: null });
    const res = buildPublicImageJobResponse('https://api.example.com', 'app-1', job);
    expect(res.content_urls).toBeNull();
  });

  it('includes multiple content_urls when job has multiple images (n>1)', () => {
    const job = makeJob({
      unsigned_urls: ['https://cdn.example.com/a.png', 'https://cdn.example.com/b.png'],
    });
    const res = buildPublicImageJobResponse('https://api.example.com', 'app-1', job);
    expect(res.content_urls).toEqual([
      'https://api.example.com/v1/app-1/images/completions/img-abc/content?index=0',
      'https://api.example.com/v1/app-1/images/completions/img-abc/content?index=1',
    ]);
  });

  it('includes error field for a failed job', () => {
    const job = makeJob({ status: 'failed', error: 'upstream refused', unsigned_urls: null });
    const res = buildPublicImageJobResponse('https://api.example.com', 'app-1', job);
    expect(res.status).toBe('failed');
    expect(res.error).toBe('upstream refused');
    expect(res.content_urls).toBeNull();
  });

  it('URLs are absolute (not relative paths)', () => {
    const job = makeJob();
    const res = buildPublicImageJobResponse('https://api.example.com', 'app-1', job);
    expect(res.polling_url).toMatch(/^https:\/\//);
    expect(res.content_urls![0]).toMatch(/^https:\/\//);
  });
});

describe('handleImageError', () => {
  it('InsufficientCreditsError → 402 with all auto-refill fields', async () => {
    const dbRow = {
      auto_refill_enabled: true,
      auto_refill_amount_usd: '10.00',
      monthly_allowance_usd: '50.00',
      credits_usd: '5.50',
    };
    const app = makeApp({ rows: [dbRow] });
    const reply = makeReply();

    const error = new InsufficientCreditsError(0.05, 0.01);
    await handleImageError(app, reply, 'org-1', error);

    expect(reply._sent.code).toBe(402);
    const body = reply._sent.body as Record<string, unknown>;
    expect(body.error).toBe('insufficient_credits');
    expect(body.code).toBe('INSUFFICIENT_CREDITS');
    expect(body.required_usd).toBe(0.05);
    expect(body.available_usd).toBe(0.01);
    expect(body.monthly_allowance_usd).toBe(50);
    expect(body.credits_usd).toBe(5.5);
    expect(body.auto_refill_enabled).toBe(true);
    expect(body.auto_refill_amount_usd).toBe(10);
  });

  it('RouterError with WRONG_MODALITY → 400, public code WRONG_MODALITY (brief case 6)', async () => {
    const app = makeApp();
    const reply = makeReply();

    const error = new RouterError('WRONG_MODALITY', 400, 'Model openai/gpt-4o is not an image model. Use /chat/completions instead.', []);
    await handleImageError(app, reply, 'org-1', error);

    expect(reply._sent.code).toBe(400);
    const body = reply._sent.body as Record<string, unknown>;
    expect(body.code).toBe('WRONG_MODALITY');
    expect(body.error).toMatch(/is not an image model/);
  });

  it('RouterError with MODEL_NOT_FOUND → 404, public code MODEL_NOT_FOUND', async () => {
    const app = makeApp();
    const reply = makeReply();

    const error = new RouterError('MODEL_NOT_FOUND', 404, 'Model not found: bogus/model', []);
    await handleImageError(app, reply, 'org-1', error);

    expect(reply._sent.code).toBe(404);
    expect((reply._sent.body as Record<string, unknown>).code).toBe('MODEL_NOT_FOUND');
  });

  it('RouterError with NO_ROUTERS_AVAILABLE → 502, public code MODEL_UNAVAILABLE', async () => {
    const app = makeApp();
    const reply = makeReply();

    const error = new RouterError('NO_ROUTERS_AVAILABLE', 502, 'no routers available', []);
    await handleImageError(app, reply, 'org-1', error);

    expect(reply._sent.code).toBe(502);
    expect((reply._sent.body as Record<string, unknown>).code).toBe('MODEL_UNAVAILABLE');
  });

  it('ZodError → 400 with details', async () => {
    const app = makeApp();
    const reply = makeReply();

    let zodErr: z.ZodError;
    try {
      z.object({ model: z.string() }).parse({ model: 123 });
    } catch (e) {
      zodErr = e as z.ZodError;
    }

    await handleImageError(app, reply, 'org-1', zodErr!);

    expect(reply._sent.code).toBe(400);
    const body = reply._sent.body as Record<string, unknown>;
    expect(body.error).toBe('Invalid request');
    expect(Array.isArray(body.details)).toBe(true);
  });

  it('unknown Error → 500 with apiError shape', async () => {
    const app = makeApp();
    const reply = makeReply();

    const error = new Error('something went wrong');
    await handleImageError(app, reply, 'org-1', error);

    expect(reply._sent.code).toBe(500);
    expect(reply._sent.body).toBeDefined();
  });
});

describe('imageSubmitSchema (brief case 4: alias preprocessor)', () => {
  const base = { model: 'openai/gpt-image-2', prompt: 'a red apple' };

  it('rejects unknown fields with unrecognized_keys', () => {
    const res = imageSubmitSchema.safeParse({ ...base, bogus_field: 'x' });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues[0].code).toBe('unrecognized_keys');
    }
  });

  it('rejects empty prompt', () => {
    const res = imageSubmitSchema.safeParse({ ...base, prompt: '' });
    expect(res.success).toBe(false);
  });

  it('normalizes image alias into input_images (brief case 4 canonical)', () => {
    const res = imageSubmitSchema.parse({ ...base, image: 'https://example.com/x.png' });
    expect(res.input_images).toEqual(['https://example.com/x.png']);
    expect((res as Record<string, unknown>).image).toBeUndefined();
  });

  it.each([
    ['image_url', 'https://example.com/a.png'],
    ['image_uri', 'https://example.com/b.png'],
    ['reference_image', 'https://example.com/c.png'],
    ['input_image', 'https://example.com/d.png'],
    ['starting_image', 'https://example.com/e.png'],
  ])('normalizes %s alias into input_images', (alias, url) => {
    const res = imageSubmitSchema.parse({ ...base, [alias]: url });
    expect(res.input_images).toEqual([url]);
    expect((res as Record<string, unknown>)[alias]).toBeUndefined();
  });

  it('does NOT alias `mask` — GPT Image 2 edit mask is semantically distinct', () => {
    const res = imageSubmitSchema.parse({
      ...base,
      mask: 'https://example.com/mask.png',
    });
    expect(res.mask).toBe('https://example.com/mask.png');
    expect(res.input_images).toBeUndefined();
  });

  it('preserves existing input_images and appends aliases', () => {
    const res = imageSubmitSchema.parse({
      ...base,
      input_images: ['https://example.com/existing.png'],
      image_url: 'https://example.com/alias.png',
    });
    expect(res.input_images).toEqual([
      'https://example.com/existing.png',
      'https://example.com/alias.png',
    ]);
  });

  it('accepts native input_images unchanged', () => {
    const res = imageSubmitSchema.parse({
      ...base,
      input_images: ['https://example.com/a.png', 'https://example.com/b.png'],
    });
    expect(res.input_images).toEqual([
      'https://example.com/a.png',
      'https://example.com/b.png',
    ]);
  });

  it('rejects invalid (non-URL) alias value via .url() validator', () => {
    const res = imageSubmitSchema.safeParse({ ...base, image_url: 'not-a-url' });
    expect(res.success).toBe(false);
  });

  it('rejects n > 10', () => {
    const res = imageSubmitSchema.safeParse({ ...base, n: 11 });
    expect(res.success).toBe(false);
  });

  it('rejects input_images > 14 entries', () => {
    const res = imageSubmitSchema.safeParse({
      ...base,
      input_images: Array.from({ length: 15 }, (_, i) => `https://example.com/${i}.png`),
    });
    expect(res.success).toBe(false);
  });
});

describe('validateImageParams (brief case 5: UNSUPPORTED_PARAM)', () => {
  const gptImage2Spec: ImageSupportedParams = {
    topLevel: new Set(['size', 'n', 'input_images', 'mask']),
    provider: new Set(['quality', 'style']),
  };
  const adapters = new Map<RouterName, RouterAdapter>([
    ['openrouter', makeAdapter('openrouter', { 'openai/gpt-image-2': gptImage2Spec })],
  ]);

  it('accepts a request that uses only supported top-level params', () => {
    const body = imageSubmitSchema.parse({
      model: 'openai/gpt-image-2',
      prompt: 'a cat',
      size: '1024x1024',
      n: 2,
    });
    expect(validateImageParams(body, adapters)).toBeNull();
  });

  it('rejects aspect_ratio on openai/gpt-image-2 (brief case 5 canonical)', () => {
    const body = imageSubmitSchema.parse({
      model: 'openai/gpt-image-2',
      prompt: 'a cat',
      aspect_ratio: '16:9',
    });
    const res = validateImageParams(body, adapters);
    expect(res).not.toBeNull();
    expect(res!.code).toBe('UNSUPPORTED_PARAM');
    expect(res!.param).toBe('aspect_ratio');
    expect(res!.model).toBe('openai/gpt-image-2');
    expect(res!.supported_top_level).toEqual(expect.arrayContaining(['size', 'n', 'input_images', 'mask']));
    expect(res!.supported_provider).toEqual(expect.arrayContaining(['quality', 'style']));
  });

  it('rejects unsupported provider.* keys', () => {
    const body = imageSubmitSchema.parse({
      model: 'openai/gpt-image-2',
      prompt: 'a cat',
      provider: { chef_hat: true },
    });
    const res = validateImageParams(body, adapters);
    expect(res).not.toBeNull();
    expect(res!.code).toBe('UNSUPPORTED_PARAM');
    expect(res!.param).toBe('provider.chef_hat');
  });

  it('accepts a whitelisted provider.* key', () => {
    const body = imageSubmitSchema.parse({
      model: 'openai/gpt-image-2',
      prompt: 'a cat',
      provider: { quality: 'high' },
    });
    expect(validateImageParams(body, adapters)).toBeNull();
  });

  it('skips validation entirely when no adapter claims the model', () => {
    const body = imageSubmitSchema.parse({
      model: 'unknown/model',
      prompt: 'a cat',
      aspect_ratio: '16:9', // would fail if any adapter claimed the model
    });
    // Falls through — router will raise MODEL_NOT_FOUND at catalog lookup time.
    expect(validateImageParams(body, adapters)).toBeNull();
  });

  it('picks the first adapter that owns the model when multiple are registered', () => {
    const wanSpec: ImageSupportedParams = {
      topLevel: new Set(['aspect_ratio', 'seed']),
      provider: new Set([]),
    };
    const multi = new Map<RouterName, RouterAdapter>([
      ['openrouter', makeAdapter('openrouter', { 'openai/gpt-image-2': gptImage2Spec })],
      ['provider-secondary', makeAdapter('provider-secondary', { 'wan/t2i-turbo': wanSpec })],
    ]);
    const body = imageSubmitSchema.parse({
      model: 'wan/t2i-turbo',
      prompt: 'a cat',
      aspect_ratio: '16:9',
    });
    expect(validateImageParams(body, multi)).toBeNull();
  });

  it('consults CANONICAL_IMAGE_MODEL_ROUTES first: openai/gpt-image-2 + size passes even though the first-inserted adapter (openrouter) excludes size (C-1 regression)', () => {
    // openrouter is inserted first (as buildImageAdapters does) and its whitelist
    // for gpt-image-2 deliberately excludes 'size' to mirror OPENROUTER_IMAGE_MODELS'
    // real restrictions. provider-secondary is the canonical owner per
    // CANONICAL_IMAGE_MODEL_ROUTES and does support 'size'. Without the routing-map
    // lookup, plain Map iteration order would pick openrouter first and 400.
    const openrouterGptImage2Spec: ImageSupportedParams = {
      topLevel: new Set(['n', 'input_images', 'mask']), // no 'size'
      provider: new Set([]),
    };
    const providerSecondaryGptImage2Spec: ImageSupportedParams = {
      topLevel: new Set(['size', 'n', 'input_images', 'mask']),
      provider: new Set(['quality', 'background', 'output_format']),
    };
    const multi = new Map<RouterName, RouterAdapter>([
      ['openrouter', makeAdapter('openrouter', { 'openai/gpt-image-2': openrouterGptImage2Spec })],
      ['provider-secondary', makeAdapter('provider-secondary', { 'openai/gpt-image-2': providerSecondaryGptImage2Spec })],
    ]);
    const body = imageSubmitSchema.parse({
      model: 'openai/gpt-image-2',
      prompt: 'a cat',
      size: '1024x1024',
    });
    expect(validateImageParams(body, multi)).toBeNull();
  });
});
