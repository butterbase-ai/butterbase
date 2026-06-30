import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { buildPublicJobResponse, handleVideoError, videoSubmitSchema } from './ai-videos.js';
import type { VideoJobRow } from '../services/ai-router/video-jobs.js';
import { RouterError, InsufficientCreditsError } from '../services/ai-router/router.js';

// Route-level integration tests (happy-path submit/poll/content flows) are
// covered by the Task 9 E2E smoke tests that run against the deployed service
// via MCP. The helpers below are pure-function unit tests that need no Fastify
// instance, Postgres, or Redis.

function makeJob(overrides: Partial<VideoJobRow> = {}): VideoJobRow {
  return {
    id: 'job-abc',
    app_id: 'app-1',
    user_id: 'user-1',
    end_user_sub: null,
    model: 'wan/t2v-turbo',
    status: 'completed',
    upstream_router: 'openrouter',
    upstream_job_id: 'upstream-xyz',
    upstream_polling_url: 'https://openrouter.ai/api/v1/generation/upstream-xyz',
    unsigned_urls: ['https://cdn.example.com/video.mp4'],
    error: null,
    lease_id: 'lease-1',
    estimated_cost_usd: '0.1000',
    provider_cost_usd: '0.0900',
    charged_credits_usd: '0.0990',
    markup_pct: '10.00',
    settled_at: new Date('2026-01-01T00:00:00Z'),
    created_at: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

// Minimal chainable reply mock for handleVideoError tests
function makeReply() {
  const sent: { code: number; body: unknown } = { code: 0, body: undefined };
  const proxy = {
    _sent: sent,
    code: vi.fn((c: number) => { sent.code = c; return proxy; }),
    send: vi.fn((b: unknown) => { sent.body = b; return proxy; }),
  };
  return proxy;
}

// Minimal app mock
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

describe('buildPublicJobResponse', () => {
  it('returns expected shape for a completed job with unsigned_urls', () => {
    const job = makeJob();
    const res = buildPublicJobResponse('https://api.example.com', 'app-1', job);
    expect(res.job_id).toBe('job-abc');
    expect(res.status).toBe('completed');
    expect(res.model).toBe('wan/t2v-turbo');
    expect(res.polling_url).toBe('https://api.example.com/v1/app-1/videos/completions/job-abc');
    expect(res.content_urls).toEqual(['https://api.example.com/v1/app-1/videos/completions/job-abc/content?index=0']);
    expect(res.error).toBeNull();
    expect(res.created_at).toBeInstanceOf(Date);
    expect(res.charged_credits_usd).toBeCloseTo(0.099, 4);
    expect(res.settled_at).toBeInstanceOf(Date);
    expect(res).not.toHaveProperty('provider_cost_usd');
  });

  it('returns null content_urls when unsigned_urls is null', () => {
    const job = makeJob({ unsigned_urls: null });
    const res = buildPublicJobResponse('https://api.example.com', 'app-1', job);
    expect(res.content_urls).toBeNull();
  });

  it('includes multiple content_urls when job has multiple videos', () => {
    const job = makeJob({
      unsigned_urls: ['https://cdn.example.com/v0.mp4', 'https://cdn.example.com/v1.mp4'],
    });
    const res = buildPublicJobResponse('https://api.example.com', 'app-1', job);
    expect(res.content_urls).toEqual([
      'https://api.example.com/v1/app-1/videos/completions/job-abc/content?index=0',
      'https://api.example.com/v1/app-1/videos/completions/job-abc/content?index=1',
    ]);
  });

  it('includes error field for a failed job', () => {
    const job = makeJob({ status: 'failed', error: 'upstream timeout', unsigned_urls: null });
    const res = buildPublicJobResponse('https://api.example.com', 'app-1', job);
    expect(res.status).toBe('failed');
    expect(res.error).toBe('upstream timeout');
    expect(res.content_urls).toBeNull();
  });

  it('URLs are absolute (not relative paths)', () => {
    const job = makeJob();
    const res = buildPublicJobResponse('https://api.example.com', 'app-1', job);
    expect(res.polling_url).toMatch(/^https:\/\//);
    expect(res.content_urls![0]).toMatch(/^https:\/\//);
  });
});

describe('handleVideoError', () => {
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
    await handleVideoError(app, reply, 'user-1', error);

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

  it('RouterError with WRONG_MODALITY → 400, public code WRONG_MODALITY', async () => {
    const app = makeApp();
    const reply = makeReply();

    const error = new RouterError('WRONG_MODALITY', 400, 'wrong modality', []);
    await handleVideoError(app, reply, 'user-1', error);

    expect(reply._sent.code).toBe(400);
    const body = reply._sent.body as Record<string, unknown>;
    expect(body.code).toBe('WRONG_MODALITY');
  });

  it('RouterError with NO_ROUTERS_AVAILABLE → 502, public code MODEL_UNAVAILABLE', async () => {
    const app = makeApp();
    const reply = makeReply();

    const error = new RouterError('NO_ROUTERS_AVAILABLE', 502, 'no routers available', []);
    await handleVideoError(app, reply, 'user-1', error);

    expect(reply._sent.code).toBe(502);
    const body = reply._sent.body as Record<string, unknown>;
    expect(body.code).toBe('MODEL_UNAVAILABLE');
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

    await handleVideoError(app, reply, 'user-1', zodErr!);

    expect(reply._sent.code).toBe(400);
    const body = reply._sent.body as Record<string, unknown>;
    expect(body.error).toBe('Invalid request');
    expect(Array.isArray(body.details)).toBe(true);
  });

  it('unknown Error → 500 with apiError shape', async () => {
    const app = makeApp();
    const reply = makeReply();

    const error = new Error('something went wrong');
    await handleVideoError(app, reply, 'user-1', error);

    expect(reply._sent.code).toBe(500);
    const body = reply._sent.body as Record<string, unknown>;
    expect(body).toBeDefined();
  });
});

describe('videoSubmitSchema', () => {
  const base = { model: 'kwaivgi/kling-v3.0', prompt: 'hi' };

  it('rejects unknown fields with unrecognized_keys', () => {
    const res = videoSubmitSchema.safeParse({ ...base, bogus_field: 'x' });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues[0].code).toBe('unrecognized_keys');
    }
  });

  it('normalizes image_url alias into input_images', () => {
    const res = videoSubmitSchema.parse({ ...base, image_url: 'https://example.com/x.jpg' });
    expect(res.input_images).toEqual(['https://example.com/x.jpg']);
    expect((res as Record<string, unknown>).image_url).toBeUndefined();
  });

  it.each([
    ['image', 'https://example.com/a.jpg'],
    ['image_uri', 'https://example.com/b.jpg'],
    ['first_frame', 'https://example.com/c.jpg'],
    ['reference_image', 'https://example.com/d.jpg'],
    ['input_image', 'https://example.com/e.jpg'],
    ['starting_image', 'https://example.com/f.jpg'],
  ])('normalizes %s alias into input_images', (alias, url) => {
    const res = videoSubmitSchema.parse({ ...base, [alias]: url });
    expect(res.input_images).toEqual([url]);
    expect((res as Record<string, unknown>)[alias]).toBeUndefined();
  });

  it('preserves existing input_images and appends aliases', () => {
    const res = videoSubmitSchema.parse({
      ...base,
      input_images: ['https://example.com/existing.jpg'],
      image_url: 'https://example.com/alias.jpg',
    });
    expect(res.input_images).toEqual([
      'https://example.com/existing.jpg',
      'https://example.com/alias.jpg',
    ]);
  });

  it('accepts native input_images unchanged', () => {
    const res = videoSubmitSchema.parse({
      ...base,
      input_images: ['https://example.com/a.jpg', 'https://example.com/b.jpg'],
    });
    expect(res.input_images).toEqual([
      'https://example.com/a.jpg',
      'https://example.com/b.jpg',
    ]);
  });

  it('rejects invalid (non-URL) alias value via .url() validator', () => {
    const res = videoSubmitSchema.safeParse({ ...base, image_url: 'not-a-url' });
    expect(res.success).toBe(false);
  });
});
