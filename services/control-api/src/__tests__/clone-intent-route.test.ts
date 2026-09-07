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

  // The templates site pre-fills `clone-of-<template>`, so every visitor
  // cloning the same template proposes the SAME name. Rejecting that turned
  // the public funnel's happy path into a 409 for everyone after the first.
  // Names are not a global namespace; subdomains are, and the clone worker
  // de-duplicates those itself.
  it('accepts a duplicate name when the dest backend is wfp', async () => {
    const prev = process.env.DEPLOYMENT_DEFAULT_BACKEND;
    process.env.DEPLOYMENT_DEFAULT_BACKEND = 'wfp';
    vi.resetModules();
    try {
      // org_app_index deliberately reports a collision: it must be ignored.
      mockControlQuery.mockResolvedValue({ rows: [{ app_id: 'app_other' }], rowCount: 1 });
      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/templates/app_src/clone-intent',
        payload: { name: 'clone-of-butter-support' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ intent_id: 'ci_1' });
      await app.close();
    } finally {
      // `process.env.X = undefined` stores the STRING "undefined", which would
      // leak 'pages' behaviour into every later file sharing this worker.
      if (prev === undefined) delete process.env.DEPLOYMENT_DEFAULT_BACKEND;
      else process.env.DEPLOYMENT_DEFAULT_BACKEND = prev;
      vi.resetModules();
    }
  });

  it('still 409s on a duplicate name on the legacy pages backend', async () => {
    const prev = process.env.DEPLOYMENT_DEFAULT_BACKEND;
    process.env.DEPLOYMENT_DEFAULT_BACKEND = 'pages';
    vi.resetModules();
    try {
      mockControlQuery.mockResolvedValue({ rows: [{ app_id: 'app_other' }], rowCount: 1 });
      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/templates/app_src/clone-intent',
        payload: { name: 'taken-name' },
      });
      expect(res.statusCode).toBe(409);
      await app.close();
    } finally {
      // `process.env.X = undefined` stores the STRING "undefined", which would
      // leak 'pages' behaviour into every later file sharing this worker.
      if (prev === undefined) delete process.env.DEPLOYMENT_DEFAULT_BACKEND;
      else process.env.DEPLOYMENT_DEFAULT_BACKEND = prev;
      vi.resetModules();
    }
  });
});
