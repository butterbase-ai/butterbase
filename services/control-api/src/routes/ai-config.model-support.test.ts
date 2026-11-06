import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { CatalogEntry } from '../services/ai-router/catalog.js';

const f = vi.hoisted(() => ({ entries: [] as CatalogEntry[], enabled: true }));
vi.mock('../services/ai-router/authorize-app-call.js', () => ({ authorizeAppAiCall: async () => ({ ok: true, ownerId: 'owner' }) }));
vi.mock('../services/region-resolver.js', () => ({ getRuntimeDbForApp: async () => ({}), resolveAppHomeRegion: async () => 'test' }));
vi.mock('../services/app-org-resolver.js', () => ({ resolveOrgFromApp: async () => 'org' }));
vi.mock('../services/ai-router/special-pricing.js', () => ({ resolveMarkupPct: async () => ({ pct: 10, source: 'default' }) }));
vi.mock('../services/redis.js', () => ({ getRedisClient: () => ({
  get: async () => JSON.stringify([{ name: 'openrouter', enabled: f.enabled }]),
}) }));
vi.mock('../services/ai-router/catalog.js', async importOriginal => ({
  ...await importOriginal<typeof import('../services/ai-router/catalog.js')>(),
  listCatalogModels: async () => f.entries.map(e => e.canonicalId),
  readCatalogEntry: async (_redis: unknown, id: string) => f.entries.find(e => e.canonicalId === id),
}));
import { aiConfigRoutes } from './ai-config.js';
import { config } from '../config.js';

const old = { enabled: config.aiRouter.enabled, key: config.aiRouter.openrouterApiKey };
let app: ReturnType<typeof Fastify>;
function model(id: string, modality: 'image' | 'video' | 'chat'): CatalogEntry {
  return { canonicalId: id, displayName: id, updatedAt: '', routers: [{ name: 'openrouter', upstreamId: id,
    modality, promptPricePerMtok: 0, completionPricePerMtok: 0, contextLength: 0 }] };
}
beforeEach(async () => {
  config.aiRouter.enabled = true; config.aiRouter.openrouterApiKey = 'test-only'; f.enabled = true;
  f.entries = [model('google/gemini-3-pro-image', 'image'), model('example/unwired-image', 'image'),
    model('example/video', 'video'), model('example/chat', 'chat')];
  app = Fastify(); app.decorate('controlDb', {} as any); await app.register(aiConfigRoutes);
});
afterEach(async () => {
  await app.close(); config.aiRouter.enabled = old.enabled; config.aiRouter.openrouterApiKey = old.key;
});
describe('model listing uses configured generation capabilities', () => {
  it('does not advertise an image that will be skipped by every image adapter', async () => {
    const response = await app.inject('/v1/test-app/ai/models');
    expect(response.statusCode).toBe(200);
    expect(response.json().models.map((m: { id: string }) => m.id)).toEqual([
      'google/gemini-3-pro-image', 'example/video', 'example/chat',
    ]);
  });
  it('applies modality filtering after executable model selection', async () => {
    expect((await app.inject('/v1/test-app/ai/models?modality=image')).json().models.map((m: { id: string }) => m.id))
      .toEqual(['google/gemini-3-pro-image']);
  });
  it('hides media on a disabled provider while retaining other modalities', async () => {
    f.enabled = false;
    expect((await app.inject('/v1/test-app/ai/models')).json().models.map((m: { id: string }) => m.id)).toEqual(['example/chat']);
  });
});
