import { describe, it, expect } from 'vitest';
import { AiClient } from './ai-client';

describe('AiClient.embed', () => {
  it('posts to /v1/:app/embeddings with the request body', async () => {
    const calls: any[] = [];
    const fc: any = {
      appId: 'app_x',
      request: (m: string, p: string, body: any) => { calls.push({ m, p, body }); return Promise.resolve({ object: 'list', model: 'm', data: [], usage: { prompt_tokens: 0, total_tokens: 0 } }); },
    };
    await new AiClient(fc).embed({ input: 'hello' });
    expect(calls[0]).toMatchObject({
      m: 'POST', p: '/v1/app_x/embeddings', body: { input: 'hello' },
    });
  });

  it('forwards model and encoding_format', async () => {
    const calls: any[] = [];
    const fc: any = {
      appId: 'app_x',
      request: (m: string, p: string, body: any) => { calls.push(body); return Promise.resolve({ object: 'list', model: 'm', data: [], usage: { prompt_tokens: 0, total_tokens: 0 } }); },
    };
    await new AiClient(fc).embed({ input: ['a', 'b'], model: 'openai/text-embedding-3-small', encoding_format: 'base64' });
    expect(calls[0]).toEqual({ input: ['a', 'b'], model: 'openai/text-embedding-3-small', encoding_format: 'base64' });
  });
});

describe('AiClient.listModels', () => {
  it('hits GET /v1/:app/ai/models', async () => {
    const calls: any[] = [];
    const fc: any = {
      appId: 'app_x',
      request: (m: string, p: string) => { calls.push({ m, p }); return Promise.resolve({ models: [] }); },
    };
    await new AiClient(fc).listModels();
    expect(calls[0]).toEqual({ m: 'GET', p: '/v1/app_x/ai/models' });
  });
});
