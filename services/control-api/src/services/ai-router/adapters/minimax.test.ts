import { describe, expect, it, vi } from 'vitest';
import { minimaxAdapter } from './minimax.js';

describe('minimax adapter', () => {
  it('lists the configured models with exact capabilities and pricing', async () => {
    const adapter = minimaxAdapter({ apiKey: 'test-key' });
    await expect(adapter.listModels()).resolves.toEqual([
      {
        upstreamId: 'MiniMax-M3',
        displayName: 'MiniMax-M3',
        promptPricePerMtok: 0.6,
        completionPricePerMtok: 2.4,
        cacheReadPricePerMtok: 0.12,
        cacheWritePricePerMtok: null,
        contextLength: 1_000_000,
        inputModalities: ['text', 'image', 'video'],
        thinking: ['adaptive', 'disabled'],
        modality: 'chat',
      },
      {
        upstreamId: 'MiniMax-M2.7',
        displayName: 'MiniMax-M2.7',
        promptPricePerMtok: 0.3,
        completionPricePerMtok: 1.2,
        cacheReadPricePerMtok: 0.06,
        cacheWritePricePerMtok: 0.375,
        contextLength: 204_800,
        inputModalities: ['text'],
        thinking: ['always_on'],
        modality: 'chat',
      },
    ]);
  });

  it('routes chat completions to the global OpenAI-compatible endpoint', async () => {
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.minimax.io/v1/chat/completions');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer test-key');
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe('MiniMax-M3');
      expect(body.thinking).toEqual({ type: 'adaptive' });
      expect(body.reasoning_effort).toBeUndefined();
      expect(body.session_id).toBeUndefined();
      return new Response(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
        usage: {
          prompt_tokens: 20,
          completion_tokens: 10,
          prompt_tokens_details: { cached_tokens: 8 },
        },
        base_resp: { status_code: 0, status_msg: '' },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;

    const adapter = minimaxAdapter({ apiKey: 'test-key', fetch: fetcher });
    const result = await adapter.chatCompletion({
      model: 'minimax/MiniMax-M3',
      messages: [{ role: 'user', content: 'hello' }],
      reasoning_effort: 'high',
      session_id: 'session-1',
    }, 'MiniMax-M3');

    expect(result.status).toBe(200);
    expect(result.usage).toMatchObject({
      promptTokens: 20,
      completionTokens: 10,
      cache_read_input_tokens: 8,
    });
  });

  it('routes chat completions to the China OpenAI-compatible endpoint', async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe('https://api.minimaxi.com/v1/chat/completions');
      return new Response(JSON.stringify({
        choices: [],
        usage: { prompt_tokens: 0, completion_tokens: 0 },
        base_resp: { status_code: 0, status_msg: '' },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;

    const adapter = minimaxAdapter({ apiKey: 'test-key', region: 'cn_zh', fetch: fetcher });
    await adapter.chatCompletion({
      model: 'minimax/MiniMax-M2.7',
      messages: [{ role: 'user', content: 'hello' }],
    }, 'MiniMax-M2.7');
  });

  it('forces streaming usage on the OpenAI-compatible path', async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.stream_options).toEqual({ include_usage: true });
      return new Response('data: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }) as unknown as typeof fetch;

    const adapter = minimaxAdapter({ apiKey: 'test-key', fetch: fetcher });
    const result = await adapter.chatCompletion({
      model: 'minimax/MiniMax-M3',
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
    }, 'MiniMax-M3');
    expect(result.stream).toBeDefined();
  });

  it('routes native messages to the selected Anthropic-compatible endpoint', async () => {
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.minimaxi.com/anthropic/v1/messages');
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer test-key');
      expect(headers['anthropic-version']).toBe('2023-06-01');
      expect(headers['anthropic-beta']).toBe('prompt-caching-2024-07-31');
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe('MiniMax-M3');
      expect(body.thinking).toEqual({ type: 'adaptive' });
      return new Response(JSON.stringify({
        id: 'message-1',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        usage: {
          input_tokens: 12,
          output_tokens: 4,
          cache_read_input_tokens: 6,
          cache_creation_input_tokens: 2,
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;

    const adapter = minimaxAdapter({ apiKey: 'test-key', region: 'cn_zh', fetch: fetcher });
    const result = await adapter.nativeMessages!({
      model: 'minimax/MiniMax-M3',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hello' }],
      thinking: { type: 'enabled', budget_tokens: 1000 },
    }, 'MiniMax-M3', {
      anthropicVersion: '2023-06-01',
      anthropicBeta: 'prompt-caching-2024-07-31',
    });

    expect(result.usage).toMatchObject({
      promptTokens: 12,
      completionTokens: 4,
      cache_read_input_tokens: 6,
      cache_creation_input_tokens: 2,
    });
  });

  it('maps canonical ids and enables native messages only for owned models', () => {
    const adapter = minimaxAdapter({ apiKey: 'test-key' });
    expect(adapter.toUpstreamId('minimax/MiniMax-M3')).toBe('MiniMax-M3');
    expect(adapter.toUpstreamId('minimax/MiniMax-M2.7')).toBe('MiniMax-M2.7');
    expect(adapter.capabilities.supportsNativeMessages('minimax/MiniMax-M3')).toBe(true);
    expect(adapter.capabilities.supportsNativeMessages('minimax/unknown')).toBe(false);
  });

  it('classifies body-level insufficient balance errors', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      base_resp: { status_code: 1008, status_msg: 'insufficient balance' },
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const adapter = minimaxAdapter({ apiKey: 'test-key', fetch: fetcher });

    await expect(adapter.chatCompletion({
      model: 'minimax/MiniMax-M3',
      messages: [{ role: 'user', content: 'hello' }],
    }, 'MiniMax-M3')).rejects.toMatchObject({
      name: 'AdapterError',
      kind: 'insufficient_credits',
      router: 'minimax',
    });
  });
});
