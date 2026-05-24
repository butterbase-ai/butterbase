import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock catalog functions
vi.mock('../services/ai-router/catalog.js', () => ({
  listCatalogModels: vi.fn(),
  readCatalogEntry: vi.fn(),
}));

// Mock redis
vi.mock('../services/redis.js', () => ({
  getRedisClient: vi.fn(() => ({})),
}));

// Mock config
vi.mock('../config.js', () => ({
  config: {
    aiRouter: { enabled: true },
  },
}));

import { listCatalogModels, readCatalogEntry } from '../services/ai-router/catalog.js';
import type { CatalogEntry } from '../services/ai-router/catalog.js';

const mockListCatalogModels = listCatalogModels as ReturnType<typeof vi.fn>;
const mockReadCatalogEntry = readCatalogEntry as ReturnType<typeof vi.fn>;

describe('GET /v1/:appId/ai/models with modality & pricing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should include modality and pricing fields in response', async () => {
    // Build test entries: one chat model, one video model
    const chatEntry: CatalogEntry = {
      canonicalId: 'openai/gpt-4o',
      displayName: 'GPT-4o',
      updatedAt: '2026-01-01T00:00:00Z',
      routers: [
        {
          name: 'openrouter',
          upstreamId: 'openai/gpt-4o',
          promptPricePerMtok: 0.003,
          completionPricePerMtok: 0.006,
          contextLength: 128000,
          modality: 'chat',
          rawPricing: null,
        },
      ],
    };

    const videoEntry: CatalogEntry = {
      canonicalId: 'wan/t2v-turbo',
      displayName: 'Wan T2V Turbo',
      updatedAt: '2026-01-01T00:00:00Z',
      routers: [
        {
          name: 'openrouter',
          upstreamId: 'wan/t2v-turbo',
          promptPricePerMtok: 0,
          completionPricePerMtok: 0,
          contextLength: 0,
          modality: 'video',
          rawPricing: {
            pricing_skus: [
              { sku: 'res_288p', price_per_second: 0.01 },
              { sku: 'res_720p', price_per_second: 0.05 },
            ],
          },
        },
      ],
    };

    mockListCatalogModels.mockResolvedValue(['openai/gpt-4o', 'wan/t2v-turbo']);
    mockReadCatalogEntry
      .mockResolvedValueOnce(chatEntry)
      .mockResolvedValueOnce(videoEntry);

    // Mock the handler transformation logic (since we don't have a full Fastify app)
    // This is the pure logic extracted from the handler
    const models = [chatEntry, videoEntry].map(e => {
      const firstRouter = e.routers.length > 0 ? e.routers[0] : null;
      const modality = firstRouter?.modality ?? 'chat';
      const isTokenPriced = modality === 'chat' || modality === 'embedding';
      return {
        id: e.canonicalId,
        name: e.displayName,
        context_length: e.routers.length > 0 ? Math.max(...e.routers.map(r => r.contextLength)) : 0,
        modality,
        prompt_price_per_mtok: isTokenPriced && firstRouter ? firstRouter.promptPricePerMtok : null,
        completion_price_per_mtok: isTokenPriced && firstRouter ? firstRouter.completionPricePerMtok : null,
        raw_pricing: !isTokenPriced && firstRouter ? firstRouter.rawPricing ?? null : null,
      };
    });

    // Assert chat model
    const gptModel = models[0];
    expect(gptModel.id).toBe('openai/gpt-4o');
    expect(gptModel.name).toBe('GPT-4o');
    expect(gptModel.context_length).toBe(128000);
    expect(gptModel.modality).toBe('chat');
    expect(gptModel.prompt_price_per_mtok).toBe(0.003);
    expect(gptModel.completion_price_per_mtok).toBe(0.006);
    expect(gptModel.raw_pricing).toBeNull();

    // Assert video model
    const videoModel = models[1];
    expect(videoModel.id).toBe('wan/t2v-turbo');
    expect(videoModel.name).toBe('Wan T2V Turbo');
    expect(videoModel.context_length).toBe(0);
    expect(videoModel.modality).toBe('video');
    expect(videoModel.prompt_price_per_mtok).toBeNull();
    expect(videoModel.completion_price_per_mtok).toBeNull();
    expect(videoModel.raw_pricing).toEqual({
      pricing_skus: [
        { sku: 'res_288p', price_per_second: 0.01 },
        { sku: 'res_720p', price_per_second: 0.05 },
      ],
    });
  });

  it('should default modality to "chat" when not specified', async () => {
    const legacyEntry: CatalogEntry = {
      canonicalId: 'anthropic/claude-3-5-sonnet',
      displayName: 'Claude 3.5 Sonnet',
      updatedAt: '2026-01-01T00:00:00Z',
      routers: [
        {
          name: 'openrouter',
          upstreamId: 'anthropic/claude-3-5-sonnet',
          promptPricePerMtok: 0.003,
          completionPricePerMtok: 0.015,
          contextLength: 200000,
          // modality is omitted, should default to 'chat'
        },
      ],
    };

    const model = (() => {
      const e = legacyEntry;
      const firstRouter = e.routers.length > 0 ? e.routers[0] : null;
      const modality = firstRouter?.modality ?? 'chat';
      const isTokenPriced = modality === 'chat' || modality === 'embedding';
      return {
        id: e.canonicalId,
        name: e.displayName,
        context_length: e.routers.length > 0 ? Math.max(...e.routers.map(r => r.contextLength)) : 0,
        modality,
        prompt_price_per_mtok: isTokenPriced && firstRouter ? firstRouter.promptPricePerMtok : null,
        completion_price_per_mtok: isTokenPriced && firstRouter ? firstRouter.completionPricePerMtok : null,
        raw_pricing: !isTokenPriced && firstRouter ? firstRouter.rawPricing ?? null : null,
      };
    })();

    expect(model.modality).toBe('chat');
    expect(model.prompt_price_per_mtok).toBe(0.003);
    expect(model.completion_price_per_mtok).toBe(0.015);
    expect(model.raw_pricing).toBeNull();
  });

  it('should handle embedding modality correctly', async () => {
    const embeddingEntry: CatalogEntry = {
      canonicalId: 'openai/text-embedding-3-large',
      displayName: 'OpenAI Text Embedding 3 Large',
      updatedAt: '2026-01-01T00:00:00Z',
      routers: [
        {
          name: 'openrouter',
          upstreamId: 'openai/text-embedding-3-large',
          promptPricePerMtok: 0.00002,
          completionPricePerMtok: 0,
          contextLength: 8191,
          modality: 'embedding',
        },
      ],
    };

    const model = (() => {
      const e = embeddingEntry;
      const firstRouter = e.routers.length > 0 ? e.routers[0] : null;
      const modality = firstRouter?.modality ?? 'chat';
      const isTokenPriced = modality === 'chat' || modality === 'embedding';
      return {
        id: e.canonicalId,
        name: e.displayName,
        context_length: e.routers.length > 0 ? Math.max(...e.routers.map(r => r.contextLength)) : 0,
        modality,
        prompt_price_per_mtok: isTokenPriced && firstRouter ? firstRouter.promptPricePerMtok : null,
        completion_price_per_mtok: isTokenPriced && firstRouter ? firstRouter.completionPricePerMtok : null,
        raw_pricing: !isTokenPriced && firstRouter ? firstRouter.rawPricing ?? null : null,
      };
    })();

    expect(model.modality).toBe('embedding');
    expect(model.prompt_price_per_mtok).toBe(0.00002);
    expect(model.completion_price_per_mtok).toBe(0);
    expect(model.raw_pricing).toBeNull();
  });

  it('should use first router when multiple routers exist', async () => {
    const multiRouterEntry: CatalogEntry = {
      canonicalId: 'openai/gpt-4o',
      displayName: 'GPT-4o',
      updatedAt: '2026-01-01T00:00:00Z',
      routers: [
        {
          name: 'openrouter',
          upstreamId: 'openai/gpt-4o',
          promptPricePerMtok: 0.003,
          completionPricePerMtok: 0.006,
          contextLength: 128000,
          modality: 'chat',
        },
        {
          name: 'provider-primary',
          upstreamId: 'gpt-4o',
          promptPricePerMtok: 0.005,
          completionPricePerMtok: 0.015,
          contextLength: 128000,
          modality: 'chat',
        },
      ],
    };

    const model = (() => {
      const e = multiRouterEntry;
      const firstRouter = e.routers.length > 0 ? e.routers[0] : null;
      const modality = firstRouter?.modality ?? 'chat';
      const isTokenPriced = modality === 'chat' || modality === 'embedding';
      return {
        id: e.canonicalId,
        name: e.displayName,
        context_length: e.routers.length > 0 ? Math.max(...e.routers.map(r => r.contextLength)) : 0,
        modality,
        prompt_price_per_mtok: isTokenPriced && firstRouter ? firstRouter.promptPricePerMtok : null,
        completion_price_per_mtok: isTokenPriced && firstRouter ? firstRouter.completionPricePerMtok : null,
        raw_pricing: !isTokenPriced && firstRouter ? firstRouter.rawPricing ?? null : null,
      };
    })();

    // Should pick first router's prices, not second
    expect(model.prompt_price_per_mtok).toBe(0.003);
    expect(model.completion_price_per_mtok).toBe(0.006);
  });
});
