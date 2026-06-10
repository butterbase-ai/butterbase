// services/control-api/src/routes/ai-meetings.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import { aiMeetingsRoutes } from './ai-meetings.js';
import {
  registerActorProvider, _resetRegistryForTests,
} from '../services/actor-providers/registry.js';
import type { ActorProvider } from '../services/actor-providers/types.js';

vi.mock('../services/redis.js', () => ({ getRedisClient: () => ({}) }));
vi.mock('../services/runtime-db.js', () => ({ getRuntimeDbPool: () => ({ query: vi.fn().mockResolvedValue({ rowCount: 1 }) }) }));
vi.mock('../services/actor-providers/billing.js', () => ({
  reserveActorCredits: vi.fn(async () => ({ leaseId: 'lease_1', amountGrantedUsd: 0.05, expiresAt: new Date() })),
  settleActorCall: vi.fn(async () => ({ refundedUsd: 0 })),
  FLOOR_LEASE_SECONDS: 300,
}));
vi.mock('../services/region-resolver.js', () => ({
  resolveAppHomeRegion: vi.fn(async () => 'us-east-1'),
  getRuntimeDbForApp: vi.fn(async () => ({
    query: vi.fn(async () => ({ rows: [{ owner_id: 'u_1' }] })),
  })),
}));

function buildApp(provider?: ActorProvider) {
  _resetRegistryForTests();
  if (provider) registerActorProvider(provider);
  const app = Fastify();
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (req) => {
    (req as any).auth = { userId: 'u_1', appId: 'app_1', authMethod: 'api_key', scopes: ['*'] };
  });
  (app as any).controlDb = { query: vi.fn() };
  app.register(aiMeetingsRoutes);
  return app;
}

describe('POST /v1/ai/meetings', () => {
  it('501s when no adapter is registered', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST', url: '/v1/ai/meetings',
      payload: { meetingUrl: 'https://meet.google.com/abc-defg-hij' },
    });
    expect(res.statusCode).toBe(501);
    expect(JSON.parse(res.body).error.code).toBe('provider_unavailable');
  });

  it('200s and returns the bot when adapter is registered', async () => {
    const start = vi.fn(async () => ({
      id: 'bot_abc', status: 'joining', startedAt: null, completedAt: null,
      durationSeconds: null, recordingUrl: null, transcriptUrl: null,
      metadata: { app_dealId: 'd1' },
    }));
    const app = buildApp({
      key: 'meetings',
      recordingUsdPerSecond: 0.0001388,
      transcriptionUsdPerSecond: 0.0000416,
      start, get: vi.fn(), stop: vi.fn(), list: vi.fn(),
    } as unknown as ActorProvider);
    const res = await app.inject({
      method: 'POST', url: '/v1/ai/meetings',
      payload: {
        meetingUrl: 'https://meet.google.com/abc-defg-hij',
        metadata: { dealId: 'd1' },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).id).toBe('bot_abc');
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({ appId: 'app_1', userId: 'u_1', leaseId: 'lease_1' }),
      expect.objectContaining({ metadata: { dealId: 'd1' } }),
    );
  });

  // TODO(phase2): when provider.start fails post-lease, settle the lease to zero
  // to refund credits. Currently the lease leaks until TTL expiry (10min).
  it('returns 500 when provider.start throws after lease is granted', async () => {
    const start = vi.fn(async () => { throw new Error('vendor blew up'); });
    const app = buildApp({
      key: 'meetings',
      recordingUsdPerSecond: 0.0001388,
      transcriptionUsdPerSecond: 0.0000416,
      start, get: vi.fn(), stop: vi.fn(), list: vi.fn(),
    } as unknown as ActorProvider);
    const res = await app.inject({
      method: 'POST', url: '/v1/ai/meetings',
      payload: { meetingUrl: 'https://meet.google.com/abc-defg-hij' },
    });
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).error.code).toBe('internal_error');
  });

  it('400s when metadata key starts with bb_', async () => {
    const app = buildApp({ key: 'meetings' } as any);
    const res = await app.inject({
      method: 'POST', url: '/v1/ai/meetings',
      payload: {
        meetingUrl: 'https://meet.google.com/abc-defg-hij',
        metadata: { bb_app_id: 'naughty' },
      },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /v1/ai/meetings/:id', () => {
  it('returns the bot status', async () => {
    const get = vi.fn(async () => ({
      id: 'bot_abc', status: 'done', startedAt: '2026-06-11T00:00:00Z',
      completedAt: '2026-06-11T01:00:00Z', durationSeconds: 3600,
      recordingUrl: 'https://...', transcriptUrl: 'https://...', metadata: {},
    }));
    const app = buildApp({ key: 'meetings', get, start: vi.fn(), stop: vi.fn(), list: vi.fn() } as unknown as ActorProvider);
    const res = await app.inject({ method: 'GET', url: '/v1/ai/meetings/bot_abc' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).durationSeconds).toBe(3600);
  });
});

describe('DELETE /v1/ai/meetings/:id', () => {
  it('calls provider.stop and returns 204', async () => {
    const stop = vi.fn(async () => {});
    const app = buildApp({ key: 'meetings', stop, start: vi.fn(), get: vi.fn(), list: vi.fn() } as unknown as ActorProvider);
    const res = await app.inject({ method: 'DELETE', url: '/v1/ai/meetings/bot_abc' });
    expect(res.statusCode).toBe(204);
    expect(stop).toHaveBeenCalled();
  });
});

describe('GET /v1/ai/meetings', () => {
  it('returns paginated list', async () => {
    const list = vi.fn(async () => ({
      bots: [{ id: 'bot_a', status: 'done' } as any], nextCursor: 'cur1',
    }));
    const app = buildApp({ key: 'meetings', list, start: vi.fn(), get: vi.fn(), stop: vi.fn() } as unknown as ActorProvider);
    const res = await app.inject({ method: 'GET', url: '/v1/ai/meetings?limit=5' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.bots).toHaveLength(1);
    expect(body.nextCursor).toBe('cur1');
  });
});

describe('PUT /v1/:appId/ai/meetings/webhook', () => {
  it('upserts and returns a raw secret when no existing row', async () => {
    const app = buildApp();
    (app as any).controlDb.query
      .mockResolvedValueOnce({ rows: [] })   // SELECT existing → empty
      .mockResolvedValueOnce({ rowCount: 1 }); // INSERT/UPSERT

    const res = await app.inject({
      method: 'PUT',
      url: '/v1/app_1/ai/meetings/webhook',
      payload: { forward_url: 'https://example.com/wh', rotate_secret: true },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.secret).toMatch(/^wsec_/);
  });

  it('preserves existing secret when rotate_secret is false', async () => {
    const app = buildApp();
    (app as any).controlDb.query
      .mockResolvedValueOnce({ rows: [{ forward_secret_hash: 'existing-hash' }] }) // SELECT → existing
      .mockResolvedValueOnce({ rowCount: 1 }); // UPSERT

    const res = await app.inject({
      method: 'PUT',
      url: '/v1/app_1/ai/meetings/webhook',
      payload: { forward_url: 'https://example.com/wh' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.secret).toBeNull();
  });

  it('400s when forward_url is not a valid URL', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/app_1/ai/meetings/webhook',
      payload: { forward_url: 'not-a-url' },
    });
    expect(res.statusCode).toBe(400);
  });
});
