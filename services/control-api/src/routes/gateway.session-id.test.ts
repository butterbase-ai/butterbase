import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { gatewayRoutes } from './gateway.js';

// ---------- mock the router so no real DB is needed ----------
vi.mock('../services/ai-router/router.js', async (orig) => {
  const actual = await orig<typeof import('../services/ai-router/router.js')>();
  return {
    ...actual,
    routeChatCompletion: vi.fn(),
  };
});

// mock catalog so /v1/models doesn't need Redis
vi.mock('../services/ai-router/catalog.js', () => ({
  listCatalogModels: vi.fn(async () => []),
  readCatalogEntry: vi.fn(async () => null),
}));

// mock redis
vi.mock('../services/redis.js', () => ({
  getRedisClient: vi.fn(() => ({})),
}));

// mock runtime-db
vi.mock('../services/runtime-db.js', () => ({
  getRuntimeDbPool: vi.fn(() => ({})),
}));

// mock stripe-provisioning
vi.mock('../../../../cloud-overlays/billing/stripe/stripe-provisioning.js', () => ({
  provisionStripeCustomer: vi.fn(),
  getOrCreateStripeCustomer: vi.fn(),
}));

// mock auto-refill-service
vi.mock('../services/auto-refill-service.js', () => ({
  maybeTriggerAutoRefill: vi.fn(() => Promise.resolve()),
}));

import { routeChatCompletion } from '../services/ai-router/router.js';

const mockRouteChatCompletion = routeChatCompletion as ReturnType<typeof vi.fn>;

// ---------- test app builder ----------
interface AuthOverride {
  userId: string | null;
  authMethod: string;
  scopes: string[];
}

async function buildTestApp(authOverride?: AuthOverride): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  // Minimal stub for controlDb (no DB queries made in gateway routes)
  app.decorate('controlDb', { query: async () => ({ rows: [{ personal_organization_id: 'org-test' }] }) } as any);

  // Inject auth - by default valid JWT
  const auth = authOverride ?? { userId: 'test-user', authMethod: 'jwt', scopes: [] };
  app.addHook('preHandler', async (request) => {
    (request as any).auth = auth;
  });

  await app.register(gatewayRoutes);
  await app.ready();
  return app;
}

const CHAT_BODY = {
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'hello' }],
};

// ---------- tests for x-session-id header ----------

describe('POST /v1/chat/completions — x-session-id header', () => {
  let app: FastifyInstance;

  afterAll(async () => { await app?.close(); });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('1. header x-session-id only → parsed body includes session_id from header', async () => {
    app = await buildTestApp();
    mockRouteChatCompletion.mockResolvedValueOnce({ status: 200, body: { id: 'chatcmpl-1', choices: [] } });

    const r = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: CHAT_BODY,
      headers: {
        'content-type': 'application/json',
        'x-session-id': 'header-sid',
      },
    });

    expect(r.statusCode).toBe(200);
    expect(mockRouteChatCompletion).toHaveBeenCalledOnce();
    const [_ctx, body] = mockRouteChatCompletion.mock.calls[0];
    expect(body.session_id).toBe('header-sid');
  });

  it('2. header x-session-id + body session_id → body value wins', async () => {
    app = await buildTestApp();
    mockRouteChatCompletion.mockResolvedValueOnce({ status: 200, body: { id: 'chatcmpl-2', choices: [] } });

    const r = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        ...CHAT_BODY,
        session_id: 'body-sid',
      },
      headers: {
        'content-type': 'application/json',
        'x-session-id': 'header-sid',
      },
    });

    expect(r.statusCode).toBe(200);
    expect(mockRouteChatCompletion).toHaveBeenCalledOnce();
    const [_ctx, body] = mockRouteChatCompletion.mock.calls[0];
    expect(body.session_id).toBe('body-sid');
  });

  it('3. header x-session-id > 256 chars → silently rejected, no session_id set', async () => {
    app = await buildTestApp();
    mockRouteChatCompletion.mockResolvedValueOnce({ status: 200, body: { id: 'chatcmpl-3', choices: [] } });

    const longSessionId = 'x'.repeat(257);
    const r = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: CHAT_BODY,
      headers: {
        'content-type': 'application/json',
        'x-session-id': longSessionId,
      },
    });

    expect(r.statusCode).toBe(200);
    expect(mockRouteChatCompletion).toHaveBeenCalledOnce();
    const [_ctx, body] = mockRouteChatCompletion.mock.calls[0];
    expect(body.session_id).toBeUndefined();
  });
});
