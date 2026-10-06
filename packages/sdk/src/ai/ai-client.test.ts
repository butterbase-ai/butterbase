import { describe, it, expect, vi } from 'vitest';
import { AiClient } from './ai-client';
import { MeetingsClient } from './meetings-client.js';

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

describe('AiClient.decide', () => {
  it('posts to /v1/:app/ai/decide with the body verbatim', async () => {
    const calls: any[] = [];
    const fc: any = {
      appId: 'app_x',
      request: (m: string, p: string, body: any) => { calls.push({ m, p, body }); return Promise.resolve({ id: 'g', model: 'typesafe/jev-1.13', answers: {}, usage: { input_tokens: 1, output_tokens: 0, cost: 0 } }); },
    };
    const req = { state: { t: 1 }, questions: { is_bug: { type: 'noul' as const, instructions: 'bug?', criteria: { true: 'y', false: 'n' } } } };
    const { data, error } = await new AiClient(fc).decide(req);
    expect(error).toBeNull();
    expect(data?.model).toBe('typesafe/jev-1.13');
    expect(calls[0]).toEqual({ m: 'POST', p: '/v1/app_x/ai/decide', body: req });
  });

  it('returns { data: null, error } on failure', async () => {
    const fc: any = { appId: 'app_x', request: () => Promise.reject(new Error('boom')) };
    const r = await new AiClient(fc).decide({ questions: {} });
    expect(r.data).toBeNull();
    expect(r.error?.message).toBe('boom');
  });
});

describe('AiClient.listModels modality filter', () => {
  it('appends ?modality= when given', async () => {
    const calls: any[] = [];
    const fc: any = { appId: 'app_x', request: (m: string, p: string) => { calls.push({ m, p }); return Promise.resolve({ models: [] }); } };
    await new AiClient(fc).listModels({ modality: 'decisions' });
    expect(calls[0]).toEqual({ m: 'GET', p: '/v1/app_x/ai/models?modality=decisions' });
  });
});

describe('AiClient.meetings', () => {
  it('exposes .meetings as a MeetingsClient', () => {
    const ai = new AiClient({ appId: 'app_1', request: vi.fn() } as any);
    expect(ai.meetings).toBeInstanceOf(MeetingsClient);
  });
});
