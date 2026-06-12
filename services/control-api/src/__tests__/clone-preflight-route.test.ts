// Unit tests for GET /v1/templates/:source_app_id/clone-preflight
//
// Uses vi.mock to avoid real DB / crypto dependencies. Tests cover the
// four observable HTTP outcomes:
//   200 — public app, returns function env var key names + conventions
//   200 — private app whose owner is the authenticated caller
//   403 — private app + caller is NOT the owner
//   404 — app not found in user_app_index (resolveAppHomeRegion throws)

process.env.AUTH_ENCRYPTION_KEY ??= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';

// ---------------------------------------------------------------------------
// Mocks (must be declared before importing the module-under-test)
// ---------------------------------------------------------------------------

const OWNER_ID = 'usr_owner_001';

// Mock resolveAppHomeRegion: resolves 'us-east-1' for known apps, throws for unknown.
vi.mock('../services/region-resolver.js', () => ({
  resolveAppHomeRegion: vi.fn(async (_controlDb: unknown, appId: string) => {
    if (appId === 'app_unknown') throw new Error('not found');
    return 'us-east-1';
  }),
  getRuntimeDbForApp: vi.fn(),
}));

// Mock getRuntimeDbPool: returns a fake pool whose query() is configurable per test.
const mockRuntimeQuery = vi.fn();
vi.mock('../services/runtime-db.js', () => ({
  getRuntimeDbPool: vi.fn(() => ({ query: mockRuntimeQuery })),
}));

// Mock config so getRuntimeDbPool call has a stable runtimeDb object.
vi.mock('../config.js', () => ({
  config: {
    runtimeDb: {},
    auth: { enabled: false, jwtSecret: 'test' },
    devOwnerId: 'usr_dev',
    cognito: {},
  },
}));

// Mock clone-env-vars so we don't need a real AUTH_ENCRYPTION_KEY / decrypt chain.
const listSourceEnvVarKeysMock = vi.fn(async () => [
  { fn_name: 'my-fn', keys: ['BUTTERBASE_API_KEY', 'OPENAI_KEY'] as string[] },
]);
vi.mock('../services/clone-env-vars.js', () => ({
  listSourceEnvVarKeys: (...args: unknown[]) => listSourceEnvVarKeysMock(...(args as [])),
  detectConventions: vi.fn((keys: string[]) =>
    keys.includes('BUTTERBASE_API_KEY')
      ? [{ key: 'BUTTERBASE_API_KEY', convention: 'butterbase_api_key', auto_mintable: true }]
      : [],
  ),
  AUTO_MINT_CONVENTION_KEYS: ['BUTTERBASE_API_KEY', 'BB_SUBSTRATE_KEY'],
  STATIC_FILL_KEYS: ['BUTTERBASE_API_URL', 'BUTTERBASE_APP_ID'],
}));

// ---------------------------------------------------------------------------
// Build a minimal Fastify app that registers only what we need
// ---------------------------------------------------------------------------
import fp from 'fastify-plugin';
import { cloneRoutesPreflight } from '../routes/clone-preflight.js';

let testUserId: string | null = null;
let controlDbMeetingsWebhookRows: any[] = [];

async function buildApp() {
  const app = Fastify({ logger: false });

  // Minimal controlDb stub. The preflight route probes app_meetings_webhooks
  // for the NOTETAKER_WEBHOOK_SECRET classification — return whatever the
  // current test set up.
  const controlDbStub = {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('app_meetings_webhooks')) return { rows: controlDbMeetingsWebhookRows };
      return { rows: [] };
    }),
  };
  app.register(fp(async (fastify) => { fastify.decorate('controlDb', controlDbStub); }));

  // Inject auth from testUserId variable so individual tests can swap it.
  app.addHook('onRequest', (req, _reply, done) => {
    req.auth = {
      userId: testUserId,
      authMethod: 'api_key',
      scopes: ['*'],
    } as any;
    done();
  });

  app.register(cloneRoutesPreflight);
  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('GET /v1/templates/:source_app_id/clone-preflight', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 200 with functions list for a public app (anonymous caller)', async () => {
    testUserId = null;
    mockRuntimeQuery.mockResolvedValueOnce({
      rows: [{ visibility: 'public', owner_id: OWNER_ID }],
    });

    const res = await app.inject({ method: 'GET', url: '/v1/templates/app_pub/clone-preflight' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.functions).toHaveLength(1);
    expect(body.functions[0].fn_name).toBe('my-fn');
    expect(body.functions[0].keys).toContain('BUTTERBASE_API_KEY');
    expect(body.functions[0].conventions[0].convention).toBe('butterbase_api_key');
    expect(body.functions[0].conventions[0].auto_mintable).toBe(true);
  });

  it('returns 200 for a private app when the caller is the owner', async () => {
    testUserId = OWNER_ID;
    mockRuntimeQuery.mockResolvedValueOnce({
      rows: [{ visibility: 'private', owner_id: OWNER_ID }],
    });

    const res = await app.inject({ method: 'GET', url: '/v1/templates/app_priv/clone-preflight' });
    expect(res.statusCode).toBe(200);
    expect(res.json().functions).toHaveLength(1);
  });

  it('returns 403 for a private app when the caller is NOT the owner', async () => {
    testUserId = 'usr_other';
    mockRuntimeQuery.mockResolvedValueOnce({
      rows: [{ visibility: 'private', owner_id: OWNER_ID }],
    });

    const res = await app.inject({ method: 'GET', url: '/v1/templates/app_priv/clone-preflight' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('AUTH_INSUFFICIENT_PERMISSIONS');
  });

  it('returns 404 when the app is not found in user_app_index', async () => {
    testUserId = null;

    const res = await app.inject({ method: 'GET', url: '/v1/templates/app_unknown/clone-preflight' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('RESOURCE_NOT_FOUND');
  });

  it('returns 404 when the runtime pool query returns no rows', async () => {
    testUserId = null;
    mockRuntimeQuery.mockResolvedValueOnce({ rows: [] });

    const res = await app.inject({ method: 'GET', url: '/v1/templates/app_gone/clone-preflight' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('RESOURCE_NOT_FOUND');
  });

  it('key_meta marks convention keys + static fills as auto_filled', async () => {
    testUserId = null;
    controlDbMeetingsWebhookRows = [];
    mockRuntimeQuery.mockResolvedValueOnce({ rows: [{ visibility: 'public', owner_id: OWNER_ID }] });
    listSourceEnvVarKeysMock.mockResolvedValueOnce([
      { fn_name: 'agent-chat', keys: [
        'BUTTERBASE_API_KEY', 'BB_SUBSTRATE_KEY', 'BUTTERBASE_API_URL', 'BUTTERBASE_APP_ID',
        'NOTETAKER_WEBHOOK_SECRET', 'FRONTEND_URL', 'OPENAI_KEY',
      ] },
    ]);

    const res = await app.inject({ method: 'GET', url: '/v1/templates/app_pub/clone-preflight' });
    expect(res.statusCode).toBe(200);
    const meta = res.json().functions[0].key_meta as { key: string; status: string }[];
    const byKey = Object.fromEntries(meta.map((m) => [m.key, m.status]));
    expect(byKey.BUTTERBASE_API_KEY).toBe('auto_filled');
    expect(byKey.BB_SUBSTRATE_KEY).toBe('auto_filled');
    expect(byKey.BUTTERBASE_API_URL).toBe('auto_filled');
    expect(byKey.BUTTERBASE_APP_ID).toBe('auto_filled');
    // No meetings webhook row → NOTETAKER stays user_required.
    expect(byKey.NOTETAKER_WEBHOOK_SECRET).toBe('user_required');
    expect(byKey.FRONTEND_URL).toBe('user_required');
    expect(byKey.OPENAI_KEY).toBe('user_required');
  });

  it('key_meta marks NOTETAKER_WEBHOOK_SECRET as auto_filled when source has app_meetings_webhooks', async () => {
    testUserId = null;
    controlDbMeetingsWebhookRows = [{ ok: 1 }];
    mockRuntimeQuery.mockResolvedValueOnce({ rows: [{ visibility: 'public', owner_id: OWNER_ID }] });
    listSourceEnvVarKeysMock.mockResolvedValueOnce([
      { fn_name: 'notetaker-webhook', keys: ['NOTETAKER_WEBHOOK_SECRET'] },
    ]);

    const res = await app.inject({ method: 'GET', url: '/v1/templates/app_pub/clone-preflight' });
    const meta = res.json().functions[0].key_meta as { key: string; status: string }[];
    expect(meta[0]).toMatchObject({ key: 'NOTETAKER_WEBHOOK_SECRET', status: 'auto_filled' });
  });
});
