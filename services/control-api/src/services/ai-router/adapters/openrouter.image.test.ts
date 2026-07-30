import { describe, it, expect, vi } from 'vitest';
import { openrouterAdapter } from './openrouter.js';
import type { ImageGenerationRequest } from './types.js';

/**
 * Build a fetcher that always returns the given /images/generations response
 * body with HTTP 200. Records the request body so tests can assert on the
 * OpenAI-Images-shape payload submitImage sent upstream.
 */
function imagesFetcher(responseBody: unknown, status = 200) {
  const fetcher = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    return new Response(JSON.stringify(responseBody), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
  return fetcher as unknown as typeof fetch;
}

function baseReq(overrides: Partial<ImageGenerationRequest> = {}): ImageGenerationRequest {
  return {
    model: 'openai/gpt-image-1-mini',
    prompt: 'a red panda wearing a hat',
    ...overrides,
  };
}

const B64_PNG_STUB = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

describe('openrouter adapter — image methods (POST /api/v1/images/generations)', () => {
  it('submitImage hits /images/generations with an OpenAI-Images-shape body', async () => {
    const fetcher = imagesFetcher({
      created: 1,
      data: [{ b64_json: B64_PNG_STUB, media_type: 'image/png' }],
      usage: { cost: 0.005 },
    });
    const adapter = openrouterAdapter({ apiKey: 'k', fetch: fetcher });

    await adapter.submitImage!(
      baseReq({ size: '1024x1024', n: 1, seed: 42 }),
      'openai/gpt-image-1-mini',
    );

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = (fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toContain('/images/generations');
    const sentBody = JSON.parse((init as RequestInit).body as string);
    expect(sentBody).toEqual({
      model: 'openai/gpt-image-1-mini',
      prompt: 'a red panda wearing a hat',
      n: 1,
      size: '1024x1024',
      seed: 42,
    });
  });

  it('forwards a single input_images entry as `image` string (edit mode)', async () => {
    const fetcher = imagesFetcher({
      created: 1,
      data: [{ b64_json: B64_PNG_STUB, media_type: 'image/png' }],
    });
    const adapter = openrouterAdapter({ apiKey: 'k', fetch: fetcher });

    await adapter.submitImage!(baseReq({ input_images: ['https://example.com/ref.png'] }), 'openai/gpt-image-1-mini');

    const [, init] = (fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const sentBody = JSON.parse((init as RequestInit).body as string);
    expect(sentBody.image).toBe('https://example.com/ref.png');
  });

  it('forwards multiple input_images as `image` array', async () => {
    const fetcher = imagesFetcher({
      created: 1,
      data: [{ b64_json: B64_PNG_STUB, media_type: 'image/png' }],
    });
    const adapter = openrouterAdapter({ apiKey: 'k', fetch: fetcher });

    await adapter.submitImage!(
      baseReq({ input_images: ['https://example.com/a.png', 'https://example.com/b.png'] }),
      'openai/gpt-image-1-mini',
    );

    const [, init] = (fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const sentBody = JSON.parse((init as RequestInit).body as string);
    expect(sentBody.image).toEqual(['https://example.com/a.png', 'https://example.com/b.png']);
  });

  it('omits size/n/seed when not provided (no silent defaults)', async () => {
    const fetcher = imagesFetcher({
      created: 1,
      data: [{ b64_json: B64_PNG_STUB, media_type: 'image/png' }],
    });
    const adapter = openrouterAdapter({ apiKey: 'k', fetch: fetcher });

    await adapter.submitImage!(baseReq(), 'openai/gpt-image-1-mini');

    const [, init] = (fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const sentBody = JSON.parse((init as RequestInit).body as string);
    expect('size' in sentBody).toBe(false);
    expect('n' in sentBody).toBe(false);
    expect('seed' in sentBody).toBe(false);
  });

  it('returns status=completed with a data: URI derived from b64_json + media_type', async () => {
    const fetcher = imagesFetcher({
      created: 1,
      data: [{ b64_json: B64_PNG_STUB, media_type: 'image/jpeg' }],
      usage: { cost: 0.0343 },
    });
    const adapter = openrouterAdapter({ apiKey: 'k', fetch: fetcher });

    const out = await adapter.submitImage!(baseReq(), 'openai/gpt-image-1-mini');

    expect(out.status).toBe('completed');
    expect(out.pollingUrl).toBe('');
    expect(out.contentType).toBe('image/jpeg');
    expect(out.unsignedUrls).toHaveLength(1);
    expect(out.unsignedUrls![0]).toBe(`data:image/jpeg;base64,${B64_PNG_STUB}`);
    expect(out.providerCostUsd).toBe(0.0343);
  });

  it('defaults contentType to image/png when media_type is missing', async () => {
    const fetcher = imagesFetcher({
      created: 1,
      data: [{ b64_json: B64_PNG_STUB }],
    });
    const adapter = openrouterAdapter({ apiKey: 'k', fetch: fetcher });

    const out = await adapter.submitImage!(baseReq(), 'openai/gpt-image-1-mini');

    expect(out.contentType).toBe('image/png');
    expect(out.unsignedUrls![0].startsWith('data:image/png;base64,')).toBe(true);
  });

  it('returns status=failed (no throw) when data[0].b64_json is missing', async () => {
    const fetcher = imagesFetcher({ created: 1, data: [] });
    const adapter = openrouterAdapter({ apiKey: 'k', fetch: fetcher });

    const out = await adapter.submitImage!(baseReq(), 'openai/gpt-image-1-mini');

    expect(out.status).toBe('failed');
    expect(out.error).toBeTruthy();
    expect(out.unsignedUrls).toBeUndefined();
  });

  it('throws AdapterError on non-2xx HTTP', async () => {
    const fetcher = imagesFetcher({ error: { message: 'Model temporarily unavailable' } }, 502);
    const adapter = openrouterAdapter({ apiKey: 'k', fetch: fetcher });

    await expect(adapter.submitImage!(baseReq(), 'openai/gpt-image-1-mini')).rejects.toThrow();
  });

  it('getSupportedImageParams whitelists size/n/seed/input_images for known image models', async () => {
    const adapter = openrouterAdapter({ apiKey: 'k', fetch: imagesFetcher({}) });

    const params = adapter.getSupportedImageParams!('openai/gpt-image-1-mini');

    expect(params).not.toBeNull();
    expect(params!.topLevel.has('size')).toBe(true);
    expect(params!.topLevel.has('n')).toBe(true);
    expect(params!.topLevel.has('seed')).toBe(true);
    expect(params!.topLevel.has('input_images')).toBe(true);
    // aspect_ratio is NOT supported (OpenAI-Images uses size)
    expect(params!.topLevel.has('aspect_ratio')).toBe(false);
  });

  it('getSupportedImageParams returns null for a non-image model', async () => {
    const adapter = openrouterAdapter({ apiKey: 'k', fetch: imagesFetcher({}) });

    expect(adapter.getSupportedImageParams!('anthropic/claude-3-opus')).toBeNull();
  });

  it('getSupportedImageParams returns null for sourceful (removed due to aspect_ratio-only requirement)', async () => {
    const adapter = openrouterAdapter({ apiKey: 'k', fetch: imagesFetcher({}) });

    expect(adapter.getSupportedImageParams!('sourceful/riverflow-v2.5-pro')).toBeNull();
  });
});
