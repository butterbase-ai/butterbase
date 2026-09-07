import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import fp from 'fastify-plugin';

process.env.AUTH_ENCRYPTION_KEY ??= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const { mockCreateCloneIntent, mockRuntimeQuery, mockControlQuery } = vi.hoisted(() => ({
  mockCreateCloneIntent: vi.fn(),
  mockRuntimeQuery: vi.fn(),
  mockControlQuery: vi.fn(),
}));

// Mock ALL exports this route module will import, including the two the redeem
// handler added in Task 5 uses. A partial mock here passes in isolation and then
// breaks the moment Task 5 lands, because the route module imports names the
// mock does not provide.
vi.mock('../services/clone-intents.js', () => ({
  createCloneIntent: mockCreateCloneIntent,
  loadRedeemableIntent: vi.fn(),
  markIntentRedeemed: vi.fn(),
  CLONE_INTENT_TTL_MS: 3600_000,
}));

vi.mock('../services/region-resolver.js', () => ({
  resolveAppHomeRegion: vi.fn(async () => 'iad'),
}));

vi.mock('../services/runtime-db.js', () => ({
  getRuntimeDbPool: vi.fn(() => ({ query: mockRuntimeQuery })),
}));

// Also stubbed for Task 5 forward-compatibility — the redeem handler pulls these
// into the same route module.
vi.mock('../services/start-clone.js', () => ({ startClone: vi.fn() }));
vi.mock('../services/clone-task-queue.js', () => ({ enqueueCloneTask: vi.fn() }));
vi.mock('../services/org-resolver.js', () => ({
  resolveOrganizationId: vi.fn(async () => 'org_1'),
  assertOrgMember: vi.fn(),
}));

async function buildApp() {
  const { cloneIntentRoutes } = await import('../routes/clone-intent.js');
  const app = Fastify();
  await app.register(fp(async (f) => {
    f.decorate('controlDb', { query: mockControlQuery } as any);
  }));
  await app.register(cloneIntentRoutes);
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateCloneIntent.mockResolvedValue({ id: 'ci_1', expires_at: new Date('2026-09-07T01:00:00Z') });
  mockRuntimeQuery.mockResolvedValue({
    rows: [{ id: 'app_src', visibility: 'public', repo_latest_snapshot: 'snap_1' }],
  });
  mockControlQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('POST /v1/templates/:source_app_id/clone-intent', () => {
  it('creates an intent for a public source app without auth', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/templates/app_src/clone-intent',
      payload: { name: 'my-clone', env_var_values: { fn: { SECRET: 'hunter2' } } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ intent_id: 'ci_1' });
    expect(res.body).not.toContain('hunter2');
    await app.close();
  });

  it('404s for a non-public source app', async () => {
    mockRuntimeQuery.mockResolvedValue({
      rows: [{ id: 'app_src', visibility: 'private', repo_latest_snapshot: 'snap_1' }],
    });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST', url: '/v1/templates/app_src/clone-intent', payload: {},
    });
    expect(res.statusCode).toBe(404);
    expect(mockCreateCloneIntent).not.toHaveBeenCalled();
    await app.close();
  });

  it('400s on a non-string env var value', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/templates/app_src/clone-intent',
      payload: { env_var_values: { fn: { KEY: 5 } } },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('409s when the requested name is already taken', async () => {
    mockControlQuery.mockResolvedValue({ rows: [{ app_id: 'app_other' }], rowCount: 1 });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/templates/app_src/clone-intent',
      payload: { name: 'taken-name' },
    });
    expect(res.statusCode).toBe(409);
    await app.close();
  });
});
