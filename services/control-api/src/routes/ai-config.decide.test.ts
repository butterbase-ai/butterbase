import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

// Harness mirrors ai-config.models.test.ts (mocked catalog, redis, config) but
// builds a real Fastify app so the route handlers are exercised via app.inject.
vi.mock('../services/ai-router/catalog.js', () => ({
  listCatalogModels: vi.fn(),
  readCatalogEntry: vi.fn(),
}));
vi.mock('../services/redis.js', () => ({ getRedisClient: vi.fn(() => ({})) }));
vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  return {
    ...actual,
    config: {
      ...actual.config,
      aiRouter: { ...actual.config.aiRouter, enabled: true, openrouterApiKey: undefined, platformDefaultDecisionModel: 'typesafe/jev-1.13' },
    },
  };
});
vi.mock('../services/ai-router/authorize-app-call.js', () => ({
  authorizeAppAiCall: vi.fn(async () => ({ ok: true, ownerId: 'user_1' })),
}));
vi.mock('../services/region-resolver.js', () => ({
  getRuntimeDbForApp: vi.fn(),
  resolveAppHomeRegion: vi.fn(async () => 'us-east'),
}));
vi.mock('../services/app-org-resolver.js', () => ({
  resolveOrgFromApp: vi.fn(async () => 'org_1'),
}));
vi.mock('../services/ai-router/special-pricing.js', () => ({
  resolveMarkupPct: vi.fn(async () => ({ pct: 10, source: 'default' })),
}));
vi.mock('../services/ai-router/router.js', async () => {
  const actual = await vi.importActual<typeof import('../services/ai-router/router.js')>('../services/ai-router/router.js');
  return { ...actual, routeDecision: vi.fn(), routeChatCompletion: vi.fn(), routeEmbedding: vi.fn() };
});

import { aiConfigRoutes } from './ai-config.js';
import { getRuntimeDbForApp } from '../services/region-resolver.js';
import { listCatalogModels, readCatalogEntry } from '../services/ai-router/catalog.js';
import { routeDecision, routeChatCompletion, routeEmbedding, RouterError } from '../services/ai-router/router.js';
import { InsufficientCreditsError } from '../services/ai-router/billing-gate.js';
import { authorizeAppAiCall } from '../services/ai-router/authorize-app-call.js';
import { config } from '../config.js';
import { resolveMarkupPct } from '../services/ai-router/special-pricing.js';
import { AdapterError } from '../services/ai-router/adapters/types.js';
import type { CatalogEntry } from '../services/ai-router/catalog.js';

const routeDecisionMock = routeDecision as unknown as ReturnType<typeof vi.fn>;
const listMock = listCatalogModels as unknown as ReturnType<typeof vi.fn>;
const readMock = readCatalogEntry as unknown as ReturnType<typeof vi.fn>;

let aiConfig: Record<string, unknown> | null = null;
function setAiConfig(cfg: Record<string, unknown> | null) { aiConfig = cfg; }
function setCatalog(entries: CatalogEntry[]) {
  listMock.mockResolvedValue(entries.map(e => e.canonicalId));
  readMock.mockImplementation(async (_r: unknown, id: string) => entries.find(e => e.canonicalId === id) ?? null);
}

let app: FastifyInstance;

beforeAll(async () => {
  (getRuntimeDbForApp as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    query: vi.fn(async () => ({ rows: [{ ai_config: aiConfig }] })),
  });
  app = Fastify();
  app.decorate('controlDb', { query: vi.fn(async () => ({ rows: [] })) } as any);
  await app.register(aiConfigRoutes);
  await app.ready();
});
afterAll(async () => { await app.close(); });
const authorizeMock = authorizeAppAiCall as unknown as ReturnType<typeof vi.fn>;
beforeEach(() => {
  authorizeMock.mockReset();
  authorizeMock.mockResolvedValue({ ok: true, ownerId: 'user_1' });
  routeDecisionMock.mockReset();
  setAiConfig(null);
});

const Q = { is_bug: { type: 'noul', instructions: 'bug?', criteria: { true: 'y', false: 'n' } } };

describe('POST /v1/:appId/ai/decide', () => {
  it('uses request model when given', async () => {
    const upstreamBody = { answers: {}, usage: { input_tokens: 1, output_tokens: 0, cost: 0.0000012 } };
    routeDecisionMock.mockResolvedValue({ status: 200, body: upstreamBody });
    const r = await app.inject({ method: 'POST', url: '/v1/app_1/ai/decide', payload: { model: 'upstage/solar-decide', state: {}, questions: Q } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual(upstreamBody);
    expect(routeDecisionMock.mock.calls[0][1]).toMatchObject({ model: 'upstage/solar-decide', questions: Q });
  });

  it('falls back to defaultDecisionModel, never the chat defaultModel', async () => {
    setAiConfig({ defaultModel: 'anthropic/claude-sonnet-4.6', defaultDecisionModel: 'jaredpalmer/kev-4b' });
    routeDecisionMock.mockResolvedValue({ status: 200, body: {} });
    await app.inject({ method: 'POST', url: '/v1/app_1/ai/decide', payload: { questions: Q } });
    expect(routeDecisionMock.mock.calls[0][1].model).toBe('jaredpalmer/kev-4b');
  });

  it('falls back to the platform decision default when the app has none', async () => {
    setAiConfig({ defaultModel: 'anthropic/claude-sonnet-4.6' });
    routeDecisionMock.mockResolvedValue({ status: 200, body: {} });
    await app.inject({ method: 'POST', url: '/v1/app_1/ai/decide', payload: { questions: Q } });
    expect(routeDecisionMock.mock.calls[0][1].model).toBe('typesafe/jev-1.13');
  });

  it('passes unknown top-level fields through', async () => {
    routeDecisionMock.mockResolvedValue({ status: 200, body: {} });
    await app.inject({ method: 'POST', url: '/v1/app_1/ai/decide', payload: { questions: Q, future_field: { x: 1 } } });
    expect(routeDecisionMock.mock.calls[0][1].future_field).toEqual({ x: 1 });
  });

  it('400 when questions is missing or empty', async () => {
    expect((await app.inject({ method: 'POST', url: '/v1/app_1/ai/decide', payload: { state: {} } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/v1/app_1/ai/decide', payload: { questions: {} } })).statusCode).toBe(400);
  });

  it('400 WRONG_MODALITY is surfaced with its public code', async () => {
    routeDecisionMock.mockRejectedValue(new RouterError('WRONG_MODALITY', 400, 'Model x is not a decision model.'));
    const r = await app.inject({ method: 'POST', url: '/v1/app_1/ai/decide', payload: { model: 'openai/gpt-4o-mini', questions: Q } });
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe('WRONG_MODALITY');
  });

  it('upstream bad_request becomes 400 UPSTREAM_REJECTED with the upstream reason (not 500)', async () => {
    routeDecisionMock.mockRejectedValue(new AdapterError('openrouter', 400, 'bad_request', '{"error":{"message":"criteria must have true and false"}}'));
    const r = await app.inject({ method: 'POST', url: '/v1/app_1/ai/decide', payload: { questions: Q } });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ code: 'UPSTREAM_REJECTED', error: 'criteria must have true and false' });
  });

  const post = (payload: unknown = { questions: Q }) =>
    app.inject({ method: 'POST', url: '/v1/app_1/ai/decide', payload: payload as object });

  it('denied caller gets 403 and routeDecision is never called', async () => {
    authorizeMock.mockResolvedValue({ ok: false, status: 403, body: { error: 'forbidden' } });
    const r = await post();
    expect(r.statusCode).toBe(403);
    expect(routeDecisionMock).not.toHaveBeenCalled();
  });

  it('402 INSUFFICIENT_CREDITS', async () => {
    routeDecisionMock.mockRejectedValue(new InsufficientCreditsError({ balanceUsd: 0.5, floorUsd: 1 }));
    const r = await post();
    expect(r.statusCode).toBe(402);
    expect(r.json()).toMatchObject({ code: 'INSUFFICIENT_CREDITS', balance_usd: 0.5, credit_floor_usd: 1 });
  });

  it('404 MODEL_NOT_FOUND', async () => {
    routeDecisionMock.mockRejectedValue(new RouterError('MODEL_NOT_FOUND', 404, 'Model nope not found.'));
    const r = await post({ model: 'nope/x', questions: Q });
    expect(r.statusCode).toBe(404);
    expect(r.json().code).toBe('MODEL_NOT_FOUND');
  });

  it('502 MODEL_UNAVAILABLE for ROUTER_FALLBACK_EXHAUSTED', async () => {
    routeDecisionMock.mockRejectedValue(new RouterError('ROUTER_FALLBACK_EXHAUSTED', 502, 'all routers failed'));
    const r = await post();
    expect(r.statusCode).toBe(502);
    expect(r.json().code).toBe('MODEL_UNAVAILABLE');
  });

  it('502 MODEL_UNAVAILABLE for a non-bad_request AdapterError, without leaking upstream text', async () => {
    routeDecisionMock.mockRejectedValue(new AdapterError('openrouter', 401, 'auth', 'SECRET-UPSTREAM-DETAIL bad key'));
    const r = await post();
    expect(r.statusCode).toBe(502);
    expect(r.json().code).toBe('MODEL_UNAVAILABLE');
    expect(r.body).not.toContain('SECRET-UPSTREAM-DETAIL');
  });

  it('501 when the AI router is disabled', async () => {
    const original = config.aiRouter.enabled;
    config.aiRouter.enabled = false;
    try {
      const r = await post();
      expect(r.statusCode).toBe(501);
      expect(routeDecisionMock).not.toHaveBeenCalled();
    } finally {
      config.aiRouter.enabled = original;
    }
  });

  it('accepts a body above Fastify\'s 1 MB default (AI body limit)', async () => {
    routeDecisionMock.mockResolvedValue({ status: 200, body: {} });
    const r = await post({ questions: Q, state: { blob: 'A'.repeat(Math.floor(1.8 * 1024 * 1024)) } });
    expect(r.statusCode).toBe(200);
  });

  it('non-JSON upstream bad_request falls back to the generic reason', async () => {
    routeDecisionMock.mockRejectedValue(new AdapterError('openrouter', 400, 'bad_request', '<html>Bad Gateway</html>'));
    const r = await post();
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ code: 'UPSTREAM_REJECTED', error: 'The model provider rejected the request.' });
  });
});

describe('GET /v1/:appId/ai/models?modality=', () => {
  it('filters by modality and prices decisions per token', async () => {
    setCatalog([
      { canonicalId: 'typesafe/jev-1.13', displayName: 'Jev', updatedAt: '', routers: [{ name: 'openrouter', upstreamId: 'typesafe/jev-1.13', promptPricePerMtok: 0.042, completionPricePerMtok: 0, contextLength: 32000, modality: 'decisions' }] },
      { canonicalId: 'openai/gpt-4o-mini', displayName: 'mini', updatedAt: '', routers: [{ name: 'openrouter', upstreamId: 'openai/gpt-4o-mini', promptPricePerMtok: 0.15, completionPricePerMtok: 0.6, contextLength: 128000, modality: 'chat' }] },
    ] as CatalogEntry[]);
    (resolveMarkupPct as unknown as ReturnType<typeof vi.fn>).mockClear();
    const r = await app.inject({ method: 'GET', url: '/v1/app_1/ai/models?modality=decisions' });
    // Filter runs before pricing: only the matching model gets a markup lookup.
    expect(resolveMarkupPct).toHaveBeenCalledTimes(1);
    expect(r.statusCode).toBe(200);
    const models = r.json().models;
    expect(models.map((m: any) => m.id)).toEqual(['typesafe/jev-1.13']);
    expect(models[0].prompt_price_per_mtok).not.toBeNull();
    expect(models[0].raw_pricing).toBeNull();
  });

  it('400 INVALID_MODALITY for an unknown value', async () => {
    const r = await app.inject({ method: 'GET', url: '/v1/app_1/ai/models?modality=decison' });
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe('INVALID_MODALITY');
  });
});

describe('decision model sent to chat / embeddings routes', () => {
  it('POST /v1/:appId/chat/completions surfaces 400 WRONG_MODALITY', async () => {
    readMock.mockResolvedValue(null);
    (routeChatCompletion as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new RouterError('WRONG_MODALITY', 400, 'Model typesafe/jev-1.13 is a decision model. Use /ai/decide instead.'));
    const r = await app.inject({ method: 'POST', url: '/v1/app_1/chat/completions', payload: { model: 'typesafe/jev-1.13', messages: [{ role: 'user', content: 'hi' }] } });
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe('WRONG_MODALITY');
  });

  it('POST /v1/:appId/embeddings surfaces 400 WRONG_MODALITY', async () => {
    (routeEmbedding as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new RouterError('WRONG_MODALITY', 400, 'Model typesafe/jev-1.13 is a decision model. Use /ai/decide instead.'));
    const r = await app.inject({ method: 'POST', url: '/v1/app_1/embeddings', payload: { model: 'typesafe/jev-1.13', input: 'hi' } });
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe('WRONG_MODALITY');
  });
});
