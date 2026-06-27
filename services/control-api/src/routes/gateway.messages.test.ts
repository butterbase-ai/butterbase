import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { gatewayRoutes } from './gateway.js';

vi.mock('../services/ai-router/messages.js', () => ({
  routeMessages: vi.fn().mockResolvedValue({
    status: 200, chosen: 'openrouter',
    body: { id: 'msg_x', type: 'message', role: 'assistant', model: 'anthropic/claude-3.5-sonnet',
            content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 } },
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

describe('POST /v1/messages', () => {
  it('200 with Anthropic-shaped body', async () => {
    const app = Fastify({ logger: false });
    app.decorate('controlDb', {} as any);
    app.addHook('onRequest', async (req) => {
      (req as any).auth = { appId: null, userId: 'u', authMethod: 'api_key', scopes: ['*'] };
    });
    await app.register(gatewayRoutes);
    await app.ready();
    const res = await app.inject({
      method: 'POST', url: '/v1/messages',
      headers: { 'anthropic-version': '2023-06-01' },
      payload: { model: 'anthropic/claude-3.5-sonnet', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).type).toBe('message');
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
        method: 'POST', url: '/v1/messages',
        payload: { model: 'x', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      (config.aiRouter as any).v2EndpointsEnabled = original;
    }
  });
});
