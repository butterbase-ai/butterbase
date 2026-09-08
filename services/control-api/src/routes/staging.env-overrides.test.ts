/**
 * Route-level cover for the write path that makes staging env overrides
 * reachable at all. The store existed with no caller; these tests pin the
 * ownership gate, the validation, and the fact that a successful PUT writes
 * BOTH the durable override row and the staging app's live app_env_vars blob —
 * writing only the former would leave the override just as dead as before.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

const mocks = vi.hoisted(() => ({
  setStagingOverrides: vi.fn(),
  getStagingOverrides: vi.fn(),
  applyStagingOverridesToAppEnv: vi.fn(),
  invalidateFunctionCache: vi.fn(),
  logFromRequest: vi.fn(),
  getEnvironmentLink: vi.fn(),
  unlinkEnvironment: vi.fn(),
  getRuntimeDbForApp: vi.fn(),
  resolveAppHomeRegion: vi.fn(),
  resolveOrganizationId: vi.fn(),
  resolveApp: vi.fn(),
  enqueueCloneTask: vi.fn(),
  startStaging: vi.fn(),
  startStagingReset: vi.fn(),
  startPromote: vi.fn(),
  buildPromotePreview: vi.fn(),
  getAppPoolForApp: vi.fn(),
}));

vi.mock('../services/staging-overrides.js', () => ({
  setStagingOverrides: mocks.setStagingOverrides,
  getStagingOverrides: mocks.getStagingOverrides,
  applyStagingOverridesToAppEnv: mocks.applyStagingOverridesToAppEnv,
}));
vi.mock('../utils/cache-invalidation.js', () => ({
  invalidateFunctionCache: mocks.invalidateFunctionCache,
}));
vi.mock('../services/audit/with-audit.js', () => ({ logFromRequest: mocks.logFromRequest }));
vi.mock('../services/staging-reset.js', () => ({ startStagingReset: mocks.startStagingReset }));
vi.mock('../services/clone-task-queue.js', () => ({ enqueueCloneTask: mocks.enqueueCloneTask }));
vi.mock('../services/region-resolver.js', () => ({
  getRuntimeDbForApp: mocks.getRuntimeDbForApp,
  resolveAppHomeRegion: mocks.resolveAppHomeRegion,
}));
vi.mock('../services/org-resolver.js', () => ({
  resolveOrganizationId: mocks.resolveOrganizationId,
  assertOrgMember: vi.fn(),
}));
vi.mock('../services/app-resolver.js', async () => {
  const actual = await vi.importActual<typeof import('../services/app-resolver.js')>(
    '../services/app-resolver.js',
  );
  return { ...actual, AppResolver: { resolveApp: mocks.resolveApp } };
});
vi.mock('../services/app-environments.js', () => ({
  getEnvironmentLink: mocks.getEnvironmentLink,
  unlinkEnvironment: mocks.unlinkEnvironment,
}));
vi.mock('../services/start-staging.js', async () => {
  const actual = await vi.importActual<typeof import('../services/start-staging.js')>(
    '../services/start-staging.js',
  );
  return { ...actual, startStaging: mocks.startStaging };
});
vi.mock('../services/promote-jobs.js', () => ({ startPromote: mocks.startPromote }));
vi.mock('../services/promote-preview.js', () => ({ buildPromotePreview: mocks.buildPromotePreview }));
vi.mock('../services/app-pool.js', () => ({ getAppPoolForApp: mocks.getAppPoolForApp }));

import { stagingRoutes } from './staging.js';
import { AppNotFoundError } from '../services/app-resolver.js';

const URL = '/v1/apps/app_prod/staging/env-overrides';

function build() {
  const app = Fastify();
  app.decorate('controlDb', {} as never);
  app.addHook('onRequest', async (req) => {
    (req as never as { auth: unknown }).auth = { userId: 'u1', organizationId: 'org_1' };
  });
  app.register(stagingRoutes);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveApp.mockResolvedValue({ id: 'app_prod', owner_id: 'u1' });
  mocks.resolveOrganizationId.mockResolvedValue('org_1');
  mocks.getRuntimeDbForApp.mockResolvedValue({ query: vi.fn().mockResolvedValue({ rows: [] }) });
  mocks.getEnvironmentLink.mockResolvedValue({ staging_app_id: 'app_staging' });
  mocks.getStagingOverrides.mockResolvedValue({ STRIPE_SECRET_KEY: 'sk_test_x' });
  mocks.applyStagingOverridesToAppEnv.mockResolvedValue({ appliedKeys: ['STRIPE_SECRET_KEY'] });
  mocks.invalidateFunctionCache.mockResolvedValue({ ok: true });
});

describe('PUT /v1/apps/:app_id/staging/env-overrides', () => {
  it('stores the override AND materialises it into the staging app env', async () => {
    const res = await build().inject({
      method: 'PUT', url: URL, payload: { env_overrides: { STRIPE_SECRET_KEY: 'sk_test_x' } },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ staging_app_id: 'app_staging', keys: ['STRIPE_SECRET_KEY'] });
    expect(mocks.setStagingOverrides).toHaveBeenCalledWith(
      expect.anything(), 'app_staging', { STRIPE_SECRET_KEY: 'sk_test_x' }, 'u1',
    );
    // The write-through is the whole point: a stored override that never
    // reaches app_env_vars is still dead code as far as the runtime is
    // concerned (deno-runtime/function-loader.ts reads app_env_vars).
    expect(mocks.applyStagingOverridesToAppEnv).toHaveBeenCalledWith(
      expect.anything(), 'app_staging', { STRIPE_SECRET_KEY: 'sk_test_x' }, 'u1',
    );
  });

  it('never echoes an override VALUE back to the caller', async () => {
    const res = await build().inject({
      method: 'PUT', url: URL, payload: { env_overrides: { STRIPE_SECRET_KEY: 'sk_test_SUPERSECRET' } },
    });
    expect(res.body).not.toContain('sk_test_SUPERSECRET');
  });

  it('returns 404 and writes nothing when the caller does not own the app', async () => {
    mocks.resolveApp.mockRejectedValue(new AppNotFoundError('app_prod'));

    const res = await build().inject({
      method: 'PUT', url: URL, payload: { env_overrides: { A: '1' } },
    });

    expect(res.statusCode).toBe(404);
    expect(mocks.setStagingOverrides).not.toHaveBeenCalled();
    expect(mocks.applyStagingOverridesToAppEnv).not.toHaveBeenCalled();
    // Generic message — never leaks whether app_prod exists.
    expect(res.json().error.message).toBe('App not found.');
  });

  it('404s when the app has no staging environment', async () => {
    mocks.getEnvironmentLink.mockResolvedValue(null);

    const res = await build().inject({
      method: 'PUT', url: URL, payload: { env_overrides: { A: '1' } },
    });

    expect(res.statusCode).toBe(404);
    expect(mocks.setStagingOverrides).not.toHaveBeenCalled();
  });

  it.each([
    ['missing body key', {}],
    ['array', { env_overrides: ['A'] }],
    ['non-string value', { env_overrides: { A: 1 } }],
    ['reserved prefix', { env_overrides: { BUTTERBASE_API_KEY: 'x' } }],
  ])('400s on %s without writing', async (_label, payload) => {
    const res = await build().inject({ method: 'PUT', url: URL, payload });

    expect(res.statusCode).toBe(400);
    expect(mocks.setStagingOverrides).not.toHaveBeenCalled();
  });

  it('accepts {} as an explicit "clear all overrides"', async () => {
    mocks.applyStagingOverridesToAppEnv.mockResolvedValue({ appliedKeys: [] });

    const res = await build().inject({ method: 'PUT', url: URL, payload: { env_overrides: {} } });

    expect(res.statusCode).toBe(200);
    expect(mocks.setStagingOverrides).toHaveBeenCalledWith(expect.anything(), 'app_staging', {}, 'u1');
  });
});

describe('GET /v1/apps/:app_id/staging/env-overrides', () => {
  it('returns key names only', async () => {
    const res = await build().inject({ method: 'GET', url: URL });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ staging_app_id: 'app_staging', keys: ['STRIPE_SECRET_KEY'] });
    expect(res.body).not.toContain('sk_test_x');
  });

  it('returns an empty set when there is no staging environment', async () => {
    mocks.getEnvironmentLink.mockResolvedValue(null);

    const res = await build().inject({ method: 'GET', url: URL });

    expect(res.json()).toEqual({ staging_app_id: null, keys: [] });
    expect(mocks.getStagingOverrides).not.toHaveBeenCalled();
  });

  it('404s for a non-owner', async () => {
    mocks.resolveApp.mockRejectedValue(new AppNotFoundError('app_prod'));

    const res = await build().inject({ method: 'GET', url: URL });

    expect(res.statusCode).toBe(404);
    expect(mocks.getStagingOverrides).not.toHaveBeenCalled();
  });
});
