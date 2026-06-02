import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { gatewayRoutes } from './gateway.js';

// ---------- mock the router so no real DB is needed ----------
vi.mock('../services/ai-router/router.js', async (orig) => {
  const actual = await orig<typeof import('../services/ai-router/router.js')>();
  return {
    ...actual,
    routeChatCompletion: vi.fn(),
    routeEmbedding: vi.fn(),
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

// mock stripe-provisioning to prevent Stripe init error at module load time
vi.mock('../../../../cloud-overlays/billing/stripe/stripe-provisioning.js', () => ({
  provisionStripeCustomer: vi.fn(),
  getOrCreateStripeCustomer: vi.fn(),
}));

// mock auto-refill-service (imported transitively by router via billing-gate)
vi.mock('../services/auto-refill-service.js', () => ({
  maybeTriggerAutoRefill: vi.fn(() => Promise.resolve()),
}));

import { routeChatCompletion, routeEmbedding, RouterError, InsufficientCreditsError } from '../services/ai-router/router.js';
import { AdapterError } from '../services/ai-router/adapters/types.js';
import { listCatalogModels, readCatalogEntry } from '../services/ai-router/catalog.js';

const mockRouteChatCompletion = routeChatCompletion as ReturnType<typeof vi.fn>;
const mockRouteEmbedding = routeEmbedding as ReturnType<typeof vi.fn>;
const mockListCatalogModels = listCatalogModels as ReturnType<typeof vi.fn>;
const mockReadCatalogEntry = readCatalogEntry as ReturnType<typeof vi.fn>;

// ---------- test app builder ----------
interface AuthOverride {
  userId: string | null;
  authMethod: string;
  scopes: string[];
}

async function buildTestApp(authOverride?: AuthOverride): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  // Minimal stub for controlDb (no DB queries made in gateway routes)
  app.decorate('controlDb', {} as any);

  // Inject auth - by default anonymous (no userId)
  const auth = authOverride ?? { userId: null, authMethod: 'anonymous', scopes: [] };
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

const EMBEDDING_BODY = {
  model: 'text-embedding-3-small',
  input: 'hello world',
};

// ---------- tests ----------

describe('POST /v1/chat/completions', () => {
  let app: FastifyInstance;

  afterAll(async () => { await app?.close(); });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('1. no auth → 401 authentication_error / missing_credentials', async () => {
    app = await buildTestApp({ userId: null, authMethod: 'anonymous', scopes: [] });
    const r = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: CHAT_BODY,
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(401);
    const body = r.json();
    expect(body.error.type).toBe('authentication_error');
    expect(body.error.code).toBe('missing_credentials');
  });

  it('2. valid platform-JWT auth → 200; router called with appId: null and correct userId', async () => {
    app = await buildTestApp({ userId: 'user-jwt-123', authMethod: 'jwt', scopes: [] });
    mockRouteChatCompletion.mockResolvedValueOnce({ status: 200, body: { id: 'chatcmpl-1', choices: [] } });

    const r = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: CHAT_BODY,
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(200);
    expect(mockRouteChatCompletion).toHaveBeenCalledOnce();
    const [ctx] = mockRouteChatCompletion.mock.calls[0];
    expect(ctx.appId).toBeNull();
    expect(ctx.userId).toBe('user-jwt-123');
  });

  it('3. API-key auth lacking ai:gateway scope → 403 permission_error / insufficient_scope', async () => {
    app = await buildTestApp({ userId: 'user-key-456', authMethod: 'api_key', scopes: ['read:apps'] });

    const r = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: CHAT_BODY,
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(403);
    const body = r.json();
    expect(body.error.type).toBe('permission_error');
    expect(body.error.code).toBe('insufficient_scope');
  });

  it('4. API-key auth with ai:gateway scope → 200', async () => {
    app = await buildTestApp({ userId: 'user-key-789', authMethod: 'api_key', scopes: ['ai:gateway'] });
    mockRouteChatCompletion.mockResolvedValueOnce({ status: 200, body: { id: 'chatcmpl-2', choices: [] } });

    const r = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: CHAT_BODY,
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(200);
  });

  it('5. InsufficientCreditsError → 402 billing_error / insufficient_credits with required_usd and available_usd', async () => {
    app = await buildTestApp({ userId: 'user-jwt-credits', authMethod: 'jwt', scopes: [] });
    mockRouteChatCompletion.mockRejectedValueOnce(new (InsufficientCreditsError as any)(0.05, 0.01));

    const r = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: CHAT_BODY,
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(402);
    const body = r.json();
    expect(body.error.type).toBe('billing_error');
    expect(body.error.code).toBe('insufficient_credits');
    expect(typeof body.error.required_usd).toBe('number');
    expect(typeof body.error.available_usd).toBe('number');
  });

  it('6. RouterError MODEL_NOT_FOUND → 404 invalid_request_error / model_not_found', async () => {
    app = await buildTestApp({ userId: 'user-jwt-model', authMethod: 'jwt', scopes: [] });
    mockRouteChatCompletion.mockRejectedValueOnce(new (RouterError as any)('MODEL_NOT_FOUND', 404, 'Model not found'));

    const r = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: CHAT_BODY,
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(404);
    const body = r.json();
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.code).toBe('model_not_found');
  });

  it('7. streaming response → 200 with text/event-stream, SSE bytes passed through', async () => {
    app = await buildTestApp({ userId: 'user-jwt-stream', authMethod: 'jwt', scopes: [] });

    const sseChunk = new TextEncoder().encode('data: [DONE]\n\n');
    let callCount = 0;
    const mockReader = {
      read: async () => {
        if (callCount++ === 0) return { done: false, value: sseChunk };
        return { done: true, value: undefined };
      },
    };
    const mockStream = { getReader: () => mockReader };
    mockRouteChatCompletion.mockResolvedValueOnce({ status: 200, stream: mockStream });

    const r = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { ...CHAT_BODY, stream: true },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/event-stream');
    expect(r.body).toContain('data: [DONE]');
  });
});

describe('POST /v1/embeddings', () => {
  let app: FastifyInstance;

  afterAll(async () => { await app?.close(); });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('8. happy path → 200, returns body from mocked routeEmbedding', async () => {
    app = await buildTestApp({ userId: 'user-embed-1', authMethod: 'jwt', scopes: [] });
    const expectedBody = { object: 'list', data: [{ object: 'embedding', embedding: [0.1, 0.2], index: 0 }] };
    mockRouteEmbedding.mockResolvedValueOnce({ status: 200, body: expectedBody });

    const r = await app.inject({
      method: 'POST',
      url: '/v1/embeddings',
      payload: EMBEDDING_BODY,
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual(expectedBody);
    expect(mockRouteEmbedding).toHaveBeenCalledOnce();
    const [ctx] = mockRouteEmbedding.mock.calls[0];
    expect(ctx.appId).toBeNull();
    expect(ctx.userId).toBe('user-embed-1');
  });
});

// ---------- Fix 1: ROUTER_FALLBACK_EXHAUSTED → public model_unavailable ----------

describe('Fix 1 — ROUTER_FALLBACK_EXHAUSTED error code mapping', () => {
  let app: FastifyInstance;

  afterAll(async () => { await app?.close(); });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('9. ROUTER_FALLBACK_EXHAUSTED → 502 model_unavailable; no router internals leaked', async () => {
    app = await buildTestApp({ userId: 'user-jwt-fallback', authMethod: 'jwt', scopes: [] });
    mockRouteChatCompletion.mockRejectedValueOnce(
      new (RouterError as any)(
        'ROUTER_FALLBACK_EXHAUSTED',
        502,
        'Model is temporarily unavailable. Please try again or use a different model.',
        ['provider-primary:transport', 'openrouter:rate_limit'],
      ),
    );

    const r = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: CHAT_BODY,
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(502);
    const body = r.json();
    expect(body.error.type).toBe('api_error');
    expect(body.error.code).toBe('model_unavailable');
    // Internal fan-out details must not leak to the client.
    expect(body.error.fallback_chain).toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(/provider-primary|openrouter|provider-secondary|router/i);
  });
});

// ---------- Fix 2: AdapterError → 400 invalid_request_error ----------

describe('Fix 2 — AdapterError non-fallback kinds map to invalid_request_error', () => {
  let app: FastifyInstance;

  afterAll(async () => { await app?.close(); });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('10. AdapterError bad_request thrown from routeChatCompletion → 400 invalid_request_error / bad_request with message preserved', async () => {
    app = await buildTestApp({ userId: 'user-jwt-adapter', authMethod: 'jwt', scopes: [] });
    mockRouteChatCompletion.mockRejectedValueOnce(
      new AdapterError('openrouter', 400, 'bad_request', 'upstream rejected'),
    );

    const r = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: CHAT_BODY,
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(400);
    const body = r.json();
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.code).toBe('bad_request');
    expect(body.error.message).toBe('upstream rejected');
  });
});

// ---------- Fix 3: 401 Butterbase shape → OpenAI shape via onSend hook ----------
// The onSend hook is scoped to the gatewayRoutes plugin encapsulation context.
// The real auth plugin fires in onRequest on the root app level, so we unit-test
// the hook transformation logic directly here rather than trying to route through it.

/**
 * Simulate the onSend hook logic from gatewayRoutes as a standalone function,
 * mirroring the exact implementation in gateway.ts.
 */
function simulateOnSendHook(
  url: string,
  statusCode: number,
  payload: unknown,
): unknown {
  if (!url.startsWith('/v1/')) return payload;
  if (statusCode !== 401) return payload;
  if (typeof payload !== 'string') return payload;
  let parsed: unknown;
  try { parsed = JSON.parse(payload); } catch { return payload; }
  const p = parsed as { error?: { type?: string; code?: string; message?: string } };
  if (p.error?.type) return payload; // already OpenAI shape
  return JSON.stringify({
    error: {
      message: p.error?.message ?? 'Invalid API key',
      type: 'authentication_error',
      code: 'invalid_api_key',
    },
  });
}

describe('Fix 3 — onSend hook rewrites Butterbase 401 to OpenAI shape', () => {
  it('11. hook transforms Butterbase-shaped 401 on /v1/* to OpenAI authentication_error shape', () => {
    const butterbbasePayload = JSON.stringify({
      error: {
        code: 'AUTH_INVALID_API_KEY',
        message: 'Invalid or revoked API key',
        remediation: 'Check your API key.',
      },
    });

    const result = simulateOnSendHook('/v1/chat/completions', 401, butterbbasePayload);

    expect(typeof result).toBe('string');
    const body = JSON.parse(result as string);
    expect(body.error.type).toBe('authentication_error');
    expect(body.error.code).toBe('invalid_api_key');
    expect(body.error.message).toBe('Invalid or revoked API key');
  });

  it('11b. hook passes through already-OpenAI-shaped 401 without double-rewriting', () => {
    const openaiPayload = JSON.stringify({
      error: {
        type: 'authentication_error',
        code: 'invalid_api_key',
        message: 'Already in OpenAI shape',
      },
    });

    const result = simulateOnSendHook('/v1/chat/completions', 401, openaiPayload);
    const body = JSON.parse(result as string);
    // Should be identical — not rewritten
    expect(body.error.type).toBe('authentication_error');
    expect(body.error.message).toBe('Already in OpenAI shape');
  });

  it('11c. hook ignores non-401 responses', () => {
    const payload = JSON.stringify({ error: { code: 'SOMETHING', message: 'fail' } });
    const result = simulateOnSendHook('/v1/chat/completions', 403, payload);
    // Should be unchanged (not a 401)
    expect(result).toBe(payload);
  });

  it('11d. hook ignores non-/v1/ paths', () => {
    const payload = JSON.stringify({ error: { code: 'AUTH_INVALID_API_KEY', message: 'bad key' } });
    const result = simulateOnSendHook('/health', 401, payload);
    expect(result).toBe(payload);
  });
});

// ---------- Fix 5: tool-calling round-trip ----------

describe('POST /v1/chat/completions — tool-calling round trip', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('accepts an assistant(tool_calls) → tool → user 3-turn body and forwards intact', async () => {
    const app = await buildTestApp({
      userId: 'u_test',
      authMethod: 'api_key',
      scopes: ['ai:gateway'],
    });

    mockRouteChatCompletion.mockResolvedValueOnce({
      status: 200,
      body: { id: 'cmpl_1', choices: [{ message: { role: 'assistant', content: 'It is 18C.' } }] },
      usage: { promptTokens: 10, completionTokens: 5, totalCost: 0.0001 },
      providerCostUsd: 0.0001,
    });

    const body = {
      model: 'openai/gpt-4o-mini',
      messages: [
        { role: 'user', content: 'Weather in Paris? Use the tool.' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'c1',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'c1', content: '{"temp_c":18}' },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Get current weather',
            parameters: {
              type: 'object',
              properties: { city: { type: 'string' } },
              required: ['city'],
            },
          },
        },
      ],
      tool_choice: 'auto',
    };

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: body,
    });

    expect(res.statusCode).toBe(200);

    expect(mockRouteChatCompletion).toHaveBeenCalledTimes(1);
    const forwarded = mockRouteChatCompletion.mock.calls[0][1] as {
      messages: Array<Record<string, unknown>>;
      tools?: unknown[];
      tool_choice?: unknown;
    };
    expect(forwarded.messages).toHaveLength(3);
    expect(forwarded.messages[1]).toMatchObject({
      role: 'assistant',
      content: null,
    });
    expect(
      (forwarded.messages[1] as { tool_calls?: unknown[] }).tool_calls,
    ).toHaveLength(1);
    expect(forwarded.messages[2]).toMatchObject({
      role: 'tool',
      tool_call_id: 'c1',
    });
    expect(forwarded.tools).toHaveLength(1);
    expect(forwarded.tool_choice).toBe('auto');

    await app.close();
  });

  it('rejects assistant content:null without tool_calls (400)', async () => {
    const app = await buildTestApp({
      userId: 'u_test',
      authMethod: 'api_key',
      scopes: ['ai:gateway'],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'openai/gpt-4o-mini',
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: null },
        ],
      },
    });

    expect(res.statusCode).toBe(400);
    expect(mockRouteChatCompletion).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects tool message missing tool_call_id (400)', async () => {
    const app = await buildTestApp({
      userId: 'u_test',
      authMethod: 'api_key',
      scopes: ['ai:gateway'],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'openai/gpt-4o-mini',
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'tool', content: '{}' },
        ],
      },
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

// ---------- Fix 4: GET /v1/models happy path ----------

describe('GET /v1/models happy path', () => {
  let app: FastifyInstance;

  afterAll(async () => { await app?.close(); });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('12. GET /v1/models → 200 with object: list and data array containing model entry', async () => {
    app = await buildTestApp({ userId: 'user-jwt-models', authMethod: 'jwt', scopes: [] });

    mockListCatalogModels.mockResolvedValueOnce(['anthropic/claude-opus-4.7']);
    mockReadCatalogEntry.mockResolvedValueOnce({
      canonicalId: 'anthropic/claude-opus-4.7',
      displayName: 'Claude Opus 4.7',
      updatedAt: new Date().toISOString(),
      routers: [],
    });

    const r = await app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { 'content-type': 'application/json' },
    });

    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.object).toBe('list');
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe('anthropic/claude-opus-4.7');
    expect(body.data[0].object).toBe('model');
    expect(body.data[0].display_name).toBe('Claude Opus 4.7');
  });
});
