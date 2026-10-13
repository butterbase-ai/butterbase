// services/control-api/src/plugins/pause-gate.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

const store = new Map<string, string>();
const localRedis = {
  get: vi.fn(async (k: string) => store.get(k) ?? null),
  setex: vi.fn(async (k: string, _t: number, v: string) => { store.set(k, v); return 'OK'; }),
  del: vi.fn(async (k: string) => { store.delete(k); return 1; }),
};
const regionRedis = { del: vi.fn(async () => 1) };
const runtimeQuery = vi.fn();
const resolveApp = vi.fn();
let pauseListener: ((c: { appId: string }) => Promise<void> | void) | null = null;

vi.mock('../services/redis.js', () => ({ getRedisClient: () => localRedis }));
vi.mock('../services/redis-registry.js', () => ({ redisFor: () => regionRedis }));
vi.mock('../services/runtime-pool-registry.js', () => ({ listRuntimeRegions: () => ['us-east-1', 'us-west-2'] }));
vi.mock('../services/region-resolver.js', () => ({
  getRuntimeDbForApp: vi.fn(async () => ({ query: runtimeQuery })),
}));
vi.mock('../services/app-pause.js', () => ({
  onPauseStateChanged: (fn: any) => { pauseListener = fn; return () => {}; },
}));
vi.mock('../services/app-resolver.js', async (orig) => {
  const actual = await orig<typeof import('../services/app-resolver.js')>();
  return { ...actual, AppResolver: { resolveApp } };
});

const { default: pauseGatePlugin, isGateSkipped, appIdFromParams, readPausedState, invalidatePausedState, assertAppIdNotPaused } =
  await import('./pause-gate.js');
const { AppPausedError, AppNotFoundError } = await import('../services/app-resolver.js');

const PAUSED = { paused: true, paused_reason: 'Paused after 28 days without activity.', paused_by: 'idle_reaper' };

async function build(auth: Record<string, unknown> | null) {
  const app = Fastify();
  app.decorate('controlDb', {} as never);
  app.decorateRequest('auth', null as never);
  app.addHook('onRequest', async (req) => { (req as any).auth = auth; });
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppPausedError) return reply.code(503).send({ code: 'APP_PAUSED', paused_by: err.pausedBy });
    return reply.code(500).send({ message: err.message });
  });
  await app.register(pauseGatePlugin);
  app.get('/v1/:app_id/config', async () => ({ ok: true }));
  app.get('/v1/:appId/agents', async () => ({ ok: true }));
  app.post('/v1/:app_id/fn/:name', { config: { public: true } }, async () => ({ ok: true }));
  app.get('/v1/templates/:app_id', async () => ({ ok: true }));
  app.post('/v1/templates/:source_app_id/clone', async () => ({ ok: true }));
  app.get('/v1/internal/kv/credentials/:app_id', async () => ({ ok: true }));
  app.get('/v1/me', async () => ({ ok: true }));
  await app.ready();
  return app;
}

const owner = { userId: 'u1', organizationId: 'o1', authMethod: 'jwt' };

beforeEach(() => {
  store.clear();
  runtimeQuery.mockReset();
  resolveApp.mockReset();
  localRedis.get.mockClear(); localRedis.setex.mockClear(); regionRedis.del.mockClear();
});

describe('isGateSkipped / appIdFromParams', () => {
  it('skips exactly the listed prefixes', () => {
    for (const p of ['/v1/internal/x', '/internal/agent-tools/builtin/x', '/admin/apps', '/health', '/oauth/token',
      '/.well-known/oauth', '/dashboard/x', '/webhooks/stripe', '/v1/templates/app_1']) {
      expect(isGateSkipped(p)).toBe(true);
    }
    expect(isGateSkipped('/v1/app_1/config')).toBe(false);
    expect(isGateSkipped('/storage/app_1/upload')).toBe(false);
    expect(isGateSkipped('/auth/app_1/login')).toBe(false);
  });

  it('reads appId or app_id, never source_app_id', () => {
    expect(appIdFromParams({ appId: 'a' })).toBe('a');
    expect(appIdFromParams({ app_id: 'b' })).toBe('b');
    expect(appIdFromParams({ source_app_id: 'c' })).toBeNull();
    expect(appIdFromParams(undefined)).toBeNull();
  });
});

describe('readPausedState cache', () => {
  it('reads the home-region DB once, then serves from Redis for 30s', async () => {
    runtimeQuery.mockResolvedValue({ rows: [PAUSED] });
    const a = await readPausedState({} as never, 'app_1');
    const b = await readPausedState({} as never, 'app_1');
    expect(a).toEqual({ paused: true, reason: PAUSED.paused_reason, by: 'idle_reaper' });
    expect(b).toEqual(a);
    expect(runtimeQuery).toHaveBeenCalledOnce();
    expect(localRedis.setex).toHaveBeenCalledWith('app-paused:app_1', 30, expect.any(String));
  });

  it('returns null and caches nothing for an unknown app', async () => {
    runtimeQuery.mockResolvedValue({ rows: [] });
    expect(await readPausedState({} as never, 'nope')).toBeNull();
    expect(localRedis.setex).not.toHaveBeenCalled();
  });

  it('invalidatePausedState deletes the key in every region and never throws', async () => {
    regionRedis.del.mockRejectedValueOnce(new Error('down'));
    await expect(invalidatePausedState('app_1')).resolves.toBeUndefined();
    expect(regionRedis.del).toHaveBeenCalledTimes(2);
    expect(regionRedis.del).toHaveBeenCalledWith('app-paused:app_1');
  });

  it('the plugin registers a pause listener that busts the cache', async () => {
    await build(owner);
    expect(pauseListener).not.toBeNull();
    await pauseListener!({ appId: 'app_9' });
    expect(regionRedis.del).toHaveBeenCalledWith('app-paused:app_9');
  });
});

describe('pause gate', () => {
  it('lets everything through for a running app', async () => {
    runtimeQuery.mockResolvedValue({ rows: [{ paused: false, paused_reason: null, paused_by: null }] });
    const app = await build({ userId: null, authMethod: 'anonymous' });
    expect((await app.inject({ method: 'POST', url: '/v1/app_1/fn/x' })).statusCode).toBe(200);
  });

  it('blocks a public route for everyone, the owner included', async () => {
    runtimeQuery.mockResolvedValue({ rows: [PAUSED] });
    resolveApp.mockResolvedValue({ id: 'app_1' });
    const app = await build(owner);
    const res = await app.inject({ method: 'POST', url: '/v1/app_1/fn/x' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ code: 'APP_PAUSED', paused_by: 'idle_reaper' });
    expect(resolveApp).not.toHaveBeenCalled();
  });

  it('owner jwt on a non-public route passes (Review Focus #1)', async () => {
    runtimeQuery.mockResolvedValue({ rows: [PAUSED] });
    resolveApp.mockResolvedValue({ id: 'app_1' });
    const app = await build(owner);
    expect((await app.inject({ method: 'GET', url: '/v1/app_1/config' })).statusCode).toBe(200);
    expect(resolveApp).toHaveBeenCalledWith(expect.anything(), 'app_1', 'u1', 'o1');
  });

  it('owner api_key passes, on an :appId route too (Review Focus #1)', async () => {
    runtimeQuery.mockResolvedValue({ rows: [PAUSED] });
    resolveApp.mockResolvedValue({ id: 'app_1' });
    const app = await build({ userId: 'u1', organizationId: null, authMethod: 'api_key' });
    expect((await app.inject({ method: 'GET', url: '/v1/app_1/agents' })).statusCode).toBe(200);
  });

  it('org member jwt passes because resolveApp accepts members (Review Focus #2)', async () => {
    runtimeQuery.mockResolvedValue({ rows: [PAUSED] });
    resolveApp.mockResolvedValue({ id: 'app_1', owner_id: 'someone-else' });
    const app = await build({ userId: 'member', organizationId: 'o1', authMethod: 'jwt' });
    expect((await app.inject({ method: 'GET', url: '/v1/app_1/config' })).statusCode).toBe(200);
  });

  it('a stranger jwt is blocked (resolveApp says not found)', async () => {
    runtimeQuery.mockResolvedValue({ rows: [PAUSED] });
    resolveApp.mockRejectedValue(new AppNotFoundError('app_1'));
    const app = await build({ userId: 'x', organizationId: null, authMethod: 'jwt' });
    expect((await app.inject({ method: 'GET', url: '/v1/app_1/config' })).statusCode).toBe(503);
  });

  it('function_key is blocked even on a non-public route (Review Focus #5)', async () => {
    runtimeQuery.mockResolvedValue({ rows: [PAUSED] });
    resolveApp.mockResolvedValue({ id: 'app_1' });
    const app = await build({ userId: 'u1', authMethod: 'function_key' });
    expect((await app.inject({ method: 'GET', url: '/v1/app_1/config' })).statusCode).toBe(503);
    expect(resolveApp).not.toHaveBeenCalled();
  });

  it('end_user_jwt and anonymous are blocked', async () => {
    runtimeQuery.mockResolvedValue({ rows: [PAUSED] });
    for (const authMethod of ['end_user_jwt', 'anonymous']) {
      const app = await build({ userId: 'eu', authMethod });
      expect((await app.inject({ method: 'GET', url: '/v1/app_1/config' })).statusCode).toBe(503);
    }
  });

  it('skips template discovery, clone, and internal routes (no lookup)', async () => {
    const app = await build(null);
    for (const [method, url] of [['GET', '/v1/templates/app_1'], ['POST', '/v1/templates/app_1/clone'],
      ['GET', '/v1/internal/kv/credentials/app_1']] as const) {
      expect((await app.inject({ method, url })).statusCode).toBe(200);
    }
    expect(runtimeQuery).not.toHaveBeenCalled();
  });

  it('routes with no app id are untouched', async () => {
    const app = await build(null);
    expect((await app.inject({ method: 'GET', url: '/v1/me' })).statusCode).toBe(200);
    expect(runtimeQuery).not.toHaveBeenCalled();
  });

  it('unknown app falls through to the route (Review Focus #3)', async () => {
    runtimeQuery.mockResolvedValue({ rows: [] });
    const app = await build(null);
    expect((await app.inject({ method: 'GET', url: '/v1/app_x/config' })).statusCode).toBe(200);
  });

  it('home-region lookup that throws AppNotFoundError falls through', async () => {
    const { getRuntimeDbForApp } = await import('../services/region-resolver.js');
    (getRuntimeDbForApp as any).mockRejectedValueOnce(new AppNotFoundError('app_x'));
    const app = await build(null);
    expect((await app.inject({ method: 'GET', url: '/v1/app_x/config' })).statusCode).toBe(200);
  });

  it('Redis get rejecting is a cache miss: a paused app still gets 503', async () => {
    runtimeQuery.mockResolvedValue({ rows: [PAUSED] });
    localRedis.get.mockRejectedValueOnce(new Error('redis down'));
    const app = await build({ userId: null, authMethod: 'anonymous' });
    expect((await app.inject({ method: 'GET', url: '/v1/app_1/config' })).statusCode).toBe(503);
  });

  it('Redis setex rejecting still returns the state: a paused app gets 503', async () => {
    runtimeQuery.mockResolvedValue({ rows: [PAUSED] });
    localRedis.setex.mockRejectedValueOnce(new Error('redis down'));
    const app = await build({ userId: null, authMethod: 'anonymous' });
    expect((await app.inject({ method: 'GET', url: '/v1/app_1/config' })).statusCode).toBe(503);
  });

  it('assertAppIdNotPaused resolves for a running app when Redis get rejects', async () => {
    runtimeQuery.mockResolvedValue({ rows: [{ paused: false, paused_reason: null, paused_by: null }] });
    localRedis.get.mockRejectedValueOnce(new Error('redis down'));
    await expect(assertAppIdNotPaused({} as never, 'app_1')).resolves.toBeUndefined();
  });

  it('lookup error fails open and logs (Review Focus #4)', async () => {
    runtimeQuery.mockRejectedValue(new Error('db down'));
    const app = await build(null);
    expect((await app.inject({ method: 'GET', url: '/v1/app_1/config' })).statusCode).toBe(200);
  });
});
