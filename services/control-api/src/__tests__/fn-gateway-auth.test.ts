// Per-function auth enforcement in the fn gateway.
//
// Verifies the edge enforces trigger_config.auth='required' BEFORE forwarding
// to the Deno runtime — the historical bug was that this flag was stored but
// never read, so anonymous callers reached every function and ran with
// ctx.db as butterbase_service (RLS bypassed).
import { describe, it, expect, beforeAll, afterAll, vi, afterEach } from 'vitest';
import Fastify from 'fastify';
import { databasePlugin } from '../plugins/database.js';
import { autoApiRoutes } from '../routes/auto-api.js';

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return {
    ...actual,
    assertRegionConfig: () => ({ instanceRegion: 'test-region', regions: ['test-region'] }),
  };
});

// Control what the runtime DB returns for the apps + app_functions join.
let triggerConfig: { auth?: 'required' | 'optional' | 'none' } | null = null;
const runtimeQuery = vi.fn(async (_sql: string, _params: unknown[]) => ({
  rows: triggerConfig === null
    ? [{ paused: false, paused_reason: null, trigger_type: null, trigger_config: null }]
    : [{ paused: false, paused_reason: null, trigger_type: 'http', trigger_config: triggerConfig }],
}));
vi.mock('../services/region-resolver.js', () => ({
  getRuntimeDbForApp: vi.fn(async () => ({ query: runtimeQuery })),
}));

// Avoid hitting a real Postgres in the controlDb plugin.
vi.mock('../plugins/database.js', () => ({
  databasePlugin: async (fastify: any) => {
    fastify.decorate('controlDb', { query: vi.fn().mockResolvedValue({ rows: [] }) });
  },
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function denoOk() {
  return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('fn gateway – per-function auth enforcement', () => {
  const app = Fastify();

  beforeAll(async () => {
    app.register(databasePlugin);
    app.register(autoApiRoutes);
    await app.ready();
  });

  afterAll(async () => { await app.close(); });
  afterEach(() => { mockFetch.mockReset(); runtimeQuery.mockClear(); });

  it('rejects anonymous callers with 401 when auth:required (no forward to runtime)', async () => {
    triggerConfig = { auth: 'required' };
    const res = await app.inject({ method: 'POST', url: '/v1/app_test001/fn/private', payload: {} });
    expect(res.statusCode).toBe(401);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(res.json()).toMatchObject({ error: { code: 'AUTH_REQUIRED' } });
  });

  it('forwards anonymous callers when auth:none (legacy public endpoint)', async () => {
    triggerConfig = { auth: 'none' };
    mockFetch.mockResolvedValueOnce(denoOk());
    const res = await app.inject({ method: 'POST', url: '/v1/app_test001/fn/public', payload: {} });
    expect(res.statusCode).toBe(200);
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('forwards anonymous callers when trigger_config is empty (legacy pre-fix deploys)', async () => {
    triggerConfig = {};
    mockFetch.mockResolvedValueOnce(denoOk());
    const res = await app.inject({ method: 'POST', url: '/v1/app_test001/fn/legacy', payload: {} });
    expect(res.statusCode).toBe(200);
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('forwards when the function row is missing (runtime returns its own 404)', async () => {
    triggerConfig = null;
    mockFetch.mockResolvedValueOnce(new Response('not found', { status: 404 }));
    const res = await app.inject({ method: 'POST', url: '/v1/app_test001/fn/missing', payload: {} });
    expect(res.statusCode).toBe(404);
    expect(mockFetch).toHaveBeenCalledOnce();
  });
});
