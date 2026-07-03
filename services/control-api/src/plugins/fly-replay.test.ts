import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import flyReplayPlugin from './fly-replay.js';

const fakeRedis = () => {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    setex: vi.fn(async (k: string, _ttl: number, v: string) => { store.set(k, v); return 'OK'; }),
    del: vi.fn(async (k: string) => { store.delete(k); return 1; }),
  };
};

describe('fly-replay plugin', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    process.env.BUTTERBASE_REGION = 'us-east-1';

    app = Fastify();
    // resolveAppRegion now queries control DB's org_app_index (not the
    // per-region runtime DB), so decorate controlDb.
    const controlPool: any = {
      query: vi.fn().mockImplementation(async (_sql: string, [appId]: [string]) => {
        if (appId === 'app-local') return { rows: [{ region: 'us-east-1' }] };
        if (appId === 'app-remote') return { rows: [{ region: 'eu-west-1' }] };
        return { rows: [] };
      }),
    };
    const redis = fakeRedis();
    app.decorate('controlDb', controlPool);
    // runtimeDb stays decorated for routes that need it elsewhere, but
    // the fly-replay plugin itself no longer uses it.
    app.decorate('runtimeDb', () => controlPool);
    app.decorate('redis', redis);

    await app.register(flyReplayPlugin);

    app.get<{ Params: { appId: string } }>(
      '/v1/:appId/local',
      { config: { requiresAppRegion: true } },
      async (req) => ({ ok: true, appId: req.params.appId }),
    );
    app.get('/public', { config: { requiresAppRegion: false } }, async () => ({ ok: true }));
    await app.ready();
  });
  afterAll(async () => { await app.close(); });

  it('serves the request when the app is in the local region', async () => {
    const r = await app.inject({ method: 'GET', url: '/v1/app-local/local' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, appId: 'app-local' });
  });

  it('returns Fly-Replay when the app is in another region', async () => {
    const r = await app.inject({ method: 'GET', url: '/v1/app-remote/local' });
    expect(r.statusCode).toBe(204);
    expect(r.headers['fly-replay']).toBe('region=eu-west-1;fallback=prefer_self;timeout=3s');
    expect(r.body).toBe('');
  });

  it('translates the butterbase region to a fly region when BUTTERBASE_FLY_REGION_MAP is set', async () => {
    process.env.BUTTERBASE_FLY_REGION_MAP = 'iad:us-east-1,lhr:eu-west-1';
    try {
      const r = await app.inject({ method: 'GET', url: '/v1/app-remote/local' });
      expect(r.statusCode).toBe(204);
      expect(r.headers['fly-replay']).toBe('region=lhr;fallback=prefer_self;timeout=3s');
    } finally {
      delete process.env.BUTTERBASE_FLY_REGION_MAP;
    }
  });

  it('skips replay when fly-replay-failed header is present (fallback engaged)', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/v1/app-remote/local',
      headers: { 'fly-replay-failed': 'timeout' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.headers['fly-replay']).toBeUndefined();
    expect(r.json()).toEqual({ ok: true, appId: 'app-remote' });
  });

  it('404s when the app does not exist', async () => {
    const r = await app.inject({ method: 'GET', url: '/v1/missing/local' });
    expect(r.statusCode).toBe(404);
  });

  it('does not interfere with routes that opt out', async () => {
    const r = await app.inject({ method: 'GET', url: '/public' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['fly-replay']).toBeUndefined();
  });
});
