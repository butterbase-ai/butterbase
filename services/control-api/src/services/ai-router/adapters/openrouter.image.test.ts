import { describe, it, expect, vi } from 'vitest';
import { openrouterAdapter } from './openrouter.js';
import type { ImageGenerationRequest } from './types.js';

/**
 * Build a fetcher that always returns the given chat-completions response body
 * with HTTP 200. Records the request body it was called with so tests can
 * assert on the shape submitImage sent upstream.
 */
function chatFetcher(responseBody: unknown) {
  const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return fetcher as unknown as typeof fetch;
}

function baseReq(overrides: Partial<ImageGenerationRequest> = {}): ImageGenerationRequest {
  return {
    model: 'openai/gpt-image-2',
    prompt: 'a red panda wearing a hat',
    ...overrides,
  };
}

describe('openrouter adapter — image methods', () => {
  it('submitImage builds a chat-completions body with text + image_url parts when input_images is populated', async () => {
    const fetcher = chatFetcher({
      id: 'gen-1',
      choices: [{ message: { role: 'assistant', images: [{ image_url: { url: 'https://example.com/out.png' } }] } }],
      usage: {},
    });
    const adapter = openrouterAdapter({ apiKey: 'k', fetch: fetcher });

    await adapter.submitImage!(
      baseReq({ input_images: ['https://example.com/ref1.png', 'https://example.com/ref2.png'] }),
      'openai/gpt-image-2',
    );

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [, init] = (fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const sentBody = JSON.parse((init as RequestInit).body as string);
    expect(sentBody.model).toBe('openai/gpt-image-2');
    expect(sentBody.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'a red panda wearing a hat' },
          { type: 'image_url', image_url: { url: 'https://example.com/ref1.png' } },
          { type: 'image_url', image_url: { url: 'https://example.com/ref2.png' } },
        ],
      },
    ]);
  });

  it('returns status=completed with unsignedUrls when message.images[] is present', async () => {
    const fetcher = chatFetcher({
      id: 'gen-2',
      choices: [{
        message: {
          role: 'assistant',
          images: [{ image_url: { url: 'https://example.com/a.png' } }, { image_url: { url: 'https://example.com/b.png' } }],
        },
      }],
      usage: {},
    });
    const adapter = openrouterAdapter({ apiKey: 'k', fetch: fetcher });

    const out = await adapter.submitImage!(baseReq(), 'openai/gpt-image-2');

    expect(out.status).toBe('completed');
    expect(out.unsignedUrls).toEqual(['https://example.com/a.png', 'https://example.com/b.png']);
    expect(out.pollingUrl).toBe('');
    expect(out.upstreamJobId).toBe('gen-2');
  });

  it('handles the alternate message.content[].image_url.url shape', async () => {
    const fetcher = chatFetcher({
      id: 'gen-3',
      choices: [{
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'here you go' },
            { type: 'image_url', image_url: { url: 'https://example.com/c.png' } },
          ],
        },
      }],
      usage: {},
    });
    const adapter = openrouterAdapter({ apiKey: 'k', fetch: fetcher });

    const out = await adapter.submitImage!(baseReq(), 'openai/gpt-image-2');

    expect(out.status).toBe('completed');
    expect(out.unsignedUrls).toEqual(['https://example.com/c.png']);
  });

  it('returns status=failed with an error when no image URLs are found', async () => {
    const fetcher = chatFetcher({
      id: 'gen-4',
      choices: [{ message: { role: 'assistant', content: 'sorry, I cannot generate that' } }],
      usage: {},
    });
    const adapter = openrouterAdapter({ apiKey: 'k', fetch: fetcher });

    const out = await adapter.submitImage!(baseReq(), 'openai/gpt-image-2');

    expect(out.status).toBe('failed');
    expect(out.error).toBeTruthy();
    expect(out.unsignedUrls).toBeUndefined();
  });

  it('includes seed in the request body when set, omits it otherwise', async () => {
    const respBody = {
      id: 'gen-5',
      choices: [{ message: { role: 'assistant', images: [{ image_url: { url: 'https://example.com/d.png' } }] } }],
      usage: {},
    };

    const fetcherWithSeed = chatFetcher(respBody);
    const adapterWithSeed = openrouterAdapter({ apiKey: 'k', fetch: fetcherWithSeed });
    await adapterWithSeed.submitImage!(baseReq({ seed: 42 }), 'openai/gpt-image-2');
    const [, initWithSeed] = (fetcherWithSeed as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const bodyWithSeed = JSON.parse((initWithSeed as RequestInit).body as string);
    expect(bodyWithSeed.seed).toBe(42);

    const fetcherNoSeed = chatFetcher(respBody);
    const adapterNoSeed = openrouterAdapter({ apiKey: 'k', fetch: fetcherNoSeed });
    await adapterNoSeed.submitImage!(baseReq(), 'openai/gpt-image-2');
    const [, initNoSeed] = (fetcherNoSeed as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const bodyNoSeed = JSON.parse((initNoSeed as RequestInit).body as string);
    expect('seed' in bodyNoSeed).toBe(false);
  });

  it('getSupportedImageParams returns a whitelist including seed but excluding aspect_ratio/size/n for a known image model', async () => {
    const adapter = openrouterAdapter({ apiKey: 'k', fetch: chatFetcher({}) });

    const params = adapter.getSupportedImageParams!('openai/gpt-image-2');

    expect(params).not.toBeNull();
    expect(params!.topLevel.has('seed')).toBe(true);
    expect(params!.topLevel.has('aspect_ratio')).toBe(false);
    expect(params!.topLevel.has('size')).toBe(false);
    expect(params!.topLevel.has('n')).toBe(false);
  });

  it('getSupportedImageParams returns null for a non-image model', async () => {
    const adapter = openrouterAdapter({ apiKey: 'k', fetch: chatFetcher({}) });

    const params = adapter.getSupportedImageParams!('anthropic/claude-3-opus');

    expect(params).toBeNull();
  });
});
