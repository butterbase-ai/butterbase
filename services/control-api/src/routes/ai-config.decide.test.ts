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
  return { ...actual, routeDecision: vi.fn() };
});

import { aiConfigRoutes } from './ai-config.js';
import { getRuntimeDbForApp } from '../services/region-resolver.js';
import { listCatalogModels, readCatalogEntry } from '../services/ai-router/catalog.js';
import { routeDecision, RouterError } from '../services/ai-router/router.js';
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
beforeEach(() => {
  routeDecisionMock.mockReset();
  setAiConfig(null);
});

const Q = { is_bug: { type: 'noul', instructions: 'bug?', criteria: { true: 'y', false: 'n' } } };

describe('POST /v1/:appId/ai/decide', () => {
  it('uses request model when given', async () => {
    routeDecisionMock.mockResolvedValue({ status: 200, body: { answers: {}, usage: { input_tokens: 1, output_tokens: 0, cost: 0.0000012 } } });
    const r = await app.inject({ method: 'POST', url: '/v1/app_1/ai/decide', payload: { model: 'upstage/solar-decide', state: {}, questions: Q } });
    expect(r.statusCode).toBe(200);
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
});

describe('GET /v1/:appId/ai/models?modality=', () => {
  it('filters by modality and prices decisions per token', async () => {
    setCatalog([
      { canonicalId: 'typesafe/jev-1.13', displayName: 'Jev', updatedAt: '', routers: [{ name: 'openrouter', upstreamId: 'typesafe/jev-1.13', promptPricePerMtok: 0.042, completionPricePerMtok: 0, contextLength: 32000, modality: 'decisions' }] },
      { canonicalId: 'openai/gpt-4o-mini', displayName: 'mini', updatedAt: '', routers: [{ name: 'openrouter', upstreamId: 'openai/gpt-4o-mini', promptPricePerMtok: 0.15, completionPricePerMtok: 0.6, contextLength: 128000, modality: 'chat' }] },
    ] as CatalogEntry[]);
    const r = await app.inject({ method: 'GET', url: '/v1/app_1/ai/models?modality=decisions' });
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
