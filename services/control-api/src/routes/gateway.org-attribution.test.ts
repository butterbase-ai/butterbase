import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { gatewayRoutes } from './gateway.js';

vi.mock('../services/ai-router/responses.js', () => ({
  routeResponses: vi.fn().mockResolvedValue({
    status: 200, chosen: 'openrouter',
    body: { id: 'rsp_x', object: 'response', created_at: 1, status: 'completed',
            model: 'openai/gpt-4o', previous_response_id: null, output: [],
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
  return { ...actual, config: { ...actual.config, aiRouter: { ...actual.config.aiRouter, v2EndpointsEnabled: true } } };
});

/**
 * Builds the gateway with a caller whose auth carries `organizationId`.
 * The control DB always answers with the caller's PERSONAL org, so a test that
 * sees the personal org proves the active org was ignored.
 */
async function buildApp(organizationId: string | null) {
  const app = Fastify({ logger: false });
  app.decorate('controlDb', {
    query: async () => ({ rows: [{ personal_organization_id: 'org-personal' }] }),
  } as any);
  app.addHook('onRequest', async (req) => {
    (req as any).auth = { appId: null, userId: 'u', authMethod: 'jwt', scopes: ['*'], organizationId };
  });
  await app.register(gatewayRoutes);
  return app;
}

describe('gateway org attribution', () => {
  beforeEach(() => vi.clearAllMocks());

  it('bills the active organization when auth carries one', async () => {
    const { routeResponses } = await import('../services/ai-router/responses.js');
    const app = await buildApp('org-team');

    const res = await app.inject({
      method: 'POST', url: '/v1/responses',
      payload: { model: 'openai/gpt-4o', input: 'hi' },
    });

    expect(res.statusCode).toBe(200);
    // The org threaded into routing/billing must be the ACTIVE org, not personal.
    // auth.organizationId is already membership-validated in plugins/auth.ts.
    expect((routeResponses as any).mock.calls[0][0].organizationId).toBe('org-team');
    await app.close();
  });

  it('falls back to the personal organization when auth carries none', async () => {
    const { routeResponses } = await import('../services/ai-router/responses.js');
    const app = await buildApp(null);

    await app.inject({
      method: 'POST', url: '/v1/responses',
      payload: { model: 'openai/gpt-4o', input: 'hi' },
    });

    expect((routeResponses as any).mock.calls[0][0].organizationId).toBe('org-personal');
    await app.close();
  });
});
