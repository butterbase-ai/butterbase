import { describe, it, expect, vi } from 'vitest';
import { openrouterAdapter } from './openrouter.js';
import { AdapterError } from './types.js';

/**
 * Build a fetcher that routes by URL substring. Each entry's response is
 * returned when the URL contains its key; falls back to 404.
 */
type RouteResp = unknown | { __status: number; body?: unknown };

/**
 * Route by exact path suffix. Longer suffixes win, so /videos/models doesn't
 * collide with /models. To return a non-200, pass `{ __status: <n>, body }`.
 */
function routedFetcher(routes: Record<string, RouteResp>): typeof fetch {
  const entries = Object.entries(routes).sort((a, b) => b[0].length - a[0].length);
  return (async (url: string | URL | Request) => {
    const u = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    const pathname = u.split('?')[0].split('#')[0];
    for (const [needle, payload] of entries) {
      if (!pathname.endsWith(needle)) continue;
      if (payload && typeof payload === 'object' && '__status' in (payload as any)) {
        const p = payload as { __status: number; body?: unknown };
        return new Response(JSON.stringify(p.body ?? {}), { status: p.__status, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
}

describe('openrouter adapter', () => {
  it('listModels parses /models response (per-token prices → per-Mtok)', async () => {
    const fetcher = routedFetcher({
      '/models': { data: [{
        id: 'anthropic/claude-3-5-sonnet',
        name: 'Claude 3.5 Sonnet',
        pricing: { prompt: '0.000003', completion: '0.000015' },
        context_length: 200000,
      }] },
      '/videos/models': { data: [] },
    });
    const a = openrouterAdapter({ apiKey: 'k', fetch: fetcher });
    const models = await a.listModels();
    expect(models[0].upstreamId).toBe('anthropic/claude-3-5-sonnet');
    expect(models[0].promptPricePerMtok).toBeCloseTo(3, 4);
    expect(models[0].completionPricePerMtok).toBeCloseTo(15, 4);
    expect(models[0].contextLength).toBe(200000);
    expect(models[0].modality).toBe('chat');
  });

  it('listModels tags models by architecture.output_modalities', async () => {
    const fetcher = routedFetcher({
      '/models': { data: [
        { id: 'anthropic/claude-3-5-sonnet', name: 'Claude 3.5 Sonnet',
          pricing: { prompt: '0.000003', completion: '0.000015' }, context_length: 200000,
          architecture: { output_modalities: ['text'] } },
        { id: 'recraft/recraft-v4.1', name: 'Recraft V4.1',
          pricing: { prompt: '0', completion: '0' }, context_length: 65536,
          architecture: { output_modalities: ['image'], input_modalities: ['text', 'image'] } },
        { id: 'openai/whisper', name: 'Whisper',
          pricing: { prompt: '0', completion: '0' }, context_length: 0,
          architecture: { output_modalities: ['audio'] } },
      ] },
      '/videos/models': { data: [] },
    });
    const a = openrouterAdapter({ apiKey: 'k', fetch: fetcher });
    const models = await a.listModels();
    const byId = Object.fromEntries(models.map(m => [m.upstreamId, m.modality]));
    expect(byId['anthropic/claude-3-5-sonnet']).toBe('chat');
    expect(byId['recraft/recraft-v4.1']).toBe('image');
    expect(byId['openai/whisper']).toBe('audio');
    // Non-chat entries carry rawPricing for future media-router code.
    const img = models.find(m => m.upstreamId === 'recraft/recraft-v4.1')!;
    expect(img.rawPricing).toBeDefined();
    const chat = models.find(m => m.upstreamId === 'anthropic/claude-3-5-sonnet')!;
    expect(chat.rawPricing).toBeUndefined();
  });

  it('listModels also pulls /videos/models and tags them modality=video', async () => {
    const fetcher = routedFetcher({
      '/models': { data: [] },
      '/videos/models': { data: [{
        id: 'google/veo-3.1',
        name: 'Google: Veo 3.1',
        pricing_skus: { '720p-with-audio': '0.4' },
        supported_resolutions: ['720p', '1080p', '4K'],
        supported_aspect_ratios: ['16:9', '9:16'],
        supported_durations: [4, 6, 8],
        generate_audio: true,
        seed: false,
      }] },
    });
    const a = openrouterAdapter({ apiKey: 'k', fetch: fetcher });
    const models = await a.listModels();
    expect(models).toHaveLength(1);
    expect(models[0].upstreamId).toBe('google/veo-3.1');
    expect(models[0].modality).toBe('video');
    const raw = models[0].rawPricing as { source: string; pricing_skus: Record<string, string> | null };
    expect(raw.source).toBe('/videos/models');
    expect(raw.pricing_skus).toEqual({ '720p-with-audio': '0.4' });
  });

  it('listModels does not fail when /videos/models is unavailable', async () => {
    const fetcher = routedFetcher({
      '/models': { data: [{
        id: 'x/y', name: 'X Y',
        pricing: { prompt: '0', completion: '0' }, context_length: 4096,
      }] },
      '/videos/models': { __status: 404, body: { error: 'not found' } },
    });
    const a = openrouterAdapter({ apiKey: 'k', fetch: fetcher });
    const models = await a.listModels();
    expect(models.map(m => m.upstreamId)).toEqual(['x/y']);
  });

  it('chatCompletion non-streaming parses usage + cost', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'hi' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, total_cost: 0.001 },
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const a = openrouterAdapter({ apiKey: 'k', fetch: fetcher });
    const r = await a.chatCompletion(
      { model: 'anthropic/claude-3-5-sonnet', messages: [{ role: 'user', content: 'hi' }] },
      'anthropic/claude-3-5-sonnet'
    );
    expect(r.status).toBe(200);
    expect(r.usage?.promptTokens).toBe(10);
    expect(r.usage?.completionTokens).toBe(5);
    expect(r.providerCostUsd).toBe(0.001);
  });

  it('chatCompletion 429 throws AdapterError kind=rate_limit', async () => {
    const fetcher = vi.fn(async () => new Response('{"error":{"message":"rate"}}', { status: 429 })) as unknown as typeof fetch;
    const a = openrouterAdapter({ apiKey: 'k', fetch: fetcher });
    await expect(
      a.chatCompletion({ model: 'm', messages: [] }, 'm')
    ).rejects.toMatchObject({ kind: 'rate_limit', name: 'AdapterError' });
  });

  it('chatCompletion 401 throws kind=auth', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 401 })) as unknown as typeof fetch;
    const a = openrouterAdapter({ apiKey: 'k', fetch: fetcher });
    await expect(a.chatCompletion({ model: 'm', messages: [] }, 'm'))
      .rejects.toMatchObject({ kind: 'auth' });
  });

  it('chatCompletion 404 throws kind=model_not_available', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 404 })) as unknown as typeof fetch;
    const a = openrouterAdapter({ apiKey: 'k', fetch: fetcher });
    await expect(a.chatCompletion({ model: 'm', messages: [] }, 'm'))
      .rejects.toMatchObject({ kind: 'model_not_available' });
  });

  it('toUpstreamId is identity for OpenRouter (already canonical)', () => {
    const a = openrouterAdapter({ apiKey: 'k', fetch: vi.fn() as any });
    expect(a.toUpstreamId('anthropic/claude-3-5-sonnet')).toBe('anthropic/claude-3-5-sonnet');
  });
});

describe('openrouterAdapter — video', () => {
  it('submitVideo POSTs /videos and returns the upstream job id + polling url', async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit | undefined) => {
      expect(url).toBe('https://openrouter.ai/api/v1/videos');
      expect(init?.method).toBe('POST');
      const body = JSON.parse((init?.body as string) ?? '{}');
      expect(body.model).toBe('bytedance/seedance-2.0');
      expect(body.prompt).toBe('a cat on a piano');
      return new Response(JSON.stringify({
        id: 'job-abc',
        polling_url: 'https://openrouter.ai/api/v1/videos/job-abc',
        status: 'pending',
      }), { status: 202, headers: { 'Content-Type': 'application/json' } });
    });
    const adapter = openrouterAdapter({ apiKey: 'sk-test', fetch: fetchMock as any });
    const out = await adapter.submitVideo!(
      { model: 'bytedance/seedance-2.0', prompt: 'a cat on a piano' },
      'bytedance/seedance-2.0',
    );
    expect(out).toEqual({
      upstreamJobId: 'job-abc',
      pollingUrl: 'https://openrouter.ai/api/v1/videos/job-abc',
      status: 'pending',
    });
  });

  it('pollVideo GETs the polling url and returns terminal state with cost', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe('https://openrouter.ai/api/v1/videos/job-abc');
      return new Response(JSON.stringify({
        id: 'job-abc',
        status: 'completed',
        unsigned_urls: ['https://openrouter.ai/api/v1/videos/job-abc/content?index=0'],
        usage: { cost: 0.25, is_byok: false },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const adapter = openrouterAdapter({ apiKey: 'sk-test', fetch: fetchMock as any });
    const out = await adapter.pollVideo!('https://openrouter.ai/api/v1/videos/job-abc');
    expect(out).toEqual({
      status: 'completed',
      unsignedUrls: ['https://openrouter.ai/api/v1/videos/job-abc/content?index=0'],
      providerCostUsd: 0.25,
    });
  });

  it('submitVideo throws AdapterError with classified kind on HTTP error', async () => {
    const fetchMock = vi.fn(async () => new Response('rate limited', { status: 429 }));
    const adapter = openrouterAdapter({ apiKey: 'sk-test', fetch: fetchMock as any });
    await expect(
      adapter.submitVideo!({ model: 'x', prompt: 'y' }, 'x')
    ).rejects.toMatchObject({ kind: 'rate_limit', statusCode: 429 });
  });
});
