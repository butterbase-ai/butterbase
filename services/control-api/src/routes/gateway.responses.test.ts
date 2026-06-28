import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { gatewayRoutes } from './gateway.js';

vi.mock('../services/ai-router/responses.js', () => ({
  routeResponses: vi.fn().mockResolvedValue({
    status: 200, chosen: 'openrouter',
    body: { id: 'rsp_x', object: 'response', created_at: 1, status: 'completed',
            model: 'openai/gpt-4o', previous_response_id: null,
            output: [{ type: 'message', id: 'msg_x', role: 'assistant',
                       content: [{ type: 'output_text', text: 'hi back' }] }],
            usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } },
  }),
}));

vi.mock('../services/redis.js', () => ({ getRedisClient: vi.fn(() => ({})) }));
vi.mock('../services/runtime-db.js', () => ({ getRuntimeDbPool: vi.fn(() => ({})) }));
vi.mock('../services/ai-router/catalog.js', () => ({
  listCatalogModels: vi.fn(async () => []),
  readCatalogEntry: vi.fn(async () => null),
  readEnabledRouters: vi.fn(async () => []),
}));
vi.mock('../services/ai-router/router.js', async (orig) => {
  const actual = await orig<typeof import('../services/ai-router/router.js')>();
  return { ...actual, routeChatCompletion: vi.fn(), routeEmbedding: vi.fn() };
});

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>();
  return {
    ...actual,
    config: {
      ...actual.config,
      aiRouter: { ...actual.config.aiRouter, v2EndpointsEnabled: true },
    },
  };
});

describe('POST /v1/responses', () => {
  it('emits event: error SSE event when stream errors mid-flight', async () => {
    const { routeResponses } = await import('../services/ai-router/responses.js');
    const errStream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode('event: response.created\ndata: {}\n\n'));
        controller.error(new Error('upstream reset'));
      },
    });
    (routeResponses as any).mockResolvedValueOnce({ status: 200, stream: errStream, chosen: 'provider-secondary' });

    const app = Fastify({ logger: false });
    app.decorate('controlDb', {} as any);
    app.addHook('onRequest', async (req) => {
      (req as any).auth = { appId: null, userId: 'u', authMethod: 'api_key', scopes: ['*'] };
    });
    await app.register(gatewayRoutes);
    await app.ready();
    const res = await app.inject({
      method: 'POST', url: '/v1/responses',
      payload: { model: 'openai/gpt-4o', input: 'hi', stream: true },
    });
    expect(res.body).toContain('event: error');
  });

  it('200 with Responses-shaped body', async () => {
    const app = Fastify({ logger: false });
    app.decorate('controlDb', {} as any);
    app.addHook('onRequest', async (req) => {
      (req as any).auth = { appId: null, userId: 'u', authMethod: 'api_key', scopes: ['*'] };
    });
    await app.register(gatewayRoutes);
    await app.ready();
    const res = await app.inject({
      method: 'POST', url: '/v1/responses',
      payload: { model: 'openai/gpt-4o', input: 'hi' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).object).toBe('response');
  });

  it('returns 404 when ai_gateway_v2_endpoints flag is off', async () => {
    const { config } = await import('../config.js');
    const original = config.aiRouter.v2EndpointsEnabled;
    (config.aiRouter as any).v2EndpointsEnabled = false;
    try {
      const app = Fastify({ logger: false });
      app.decorate('controlDb', {} as any);
      app.addHook('onRequest', async (req) => {
        (req as any).auth = { appId: null, userId: 'u', authMethod: 'api_key', scopes: ['*'] };
      });
      await app.register(gatewayRoutes);
      await app.ready();
      const res = await app.inject({
        method: 'POST', url: '/v1/responses',
        payload: { model: 'openai/gpt-4o', input: 'hi' },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      (config.aiRouter as any).v2EndpointsEnabled = original;
    }
  });
});
