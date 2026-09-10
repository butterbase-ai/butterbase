import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

const mocks = vi.hoisted(() => ({
  startPromote: vi.fn(),
  buildPromotePreview: vi.fn(),
  enqueueCloneTask: vi.fn(),
  getEnvironmentLink: vi.fn(),
  unlinkEnvironment: vi.fn(),
  getAppPoolForApp: vi.fn(),
  getRuntimeDbForApp: vi.fn(),
  resolveAppHomeRegion: vi.fn(),
  resolveOrganizationId: vi.fn(),
  resolveApp: vi.fn(),
  startStaging: vi.fn(),
  getAppPlanFeatures: vi.fn(),
}));

vi.mock('../services/plan-features.js', () => ({
  getAppPlanFeatures: mocks.getAppPlanFeatures,
}));
vi.mock('../services/promote-jobs.js', () => ({ startPromote: mocks.startPromote }));
vi.mock('../services/promote-preview.js', () => ({ buildPromotePreview: mocks.buildPromotePreview }));
vi.mock('../services/clone-task-queue.js', () => ({ enqueueCloneTask: mocks.enqueueCloneTask }));
vi.mock('../services/app-environments.js', () => ({
  getEnvironmentLink: mocks.getEnvironmentLink,
  unlinkEnvironment: mocks.unlinkEnvironment,
}));
vi.mock('../services/app-pool.js', () => ({ getAppPoolForApp: mocks.getAppPoolForApp }));
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
  return {
    ...actual,
    AppResolver: { resolveApp: mocks.resolveApp },
  };
});
vi.mock('../services/start-staging.js', async () => {
  const actual = await vi.importActual<typeof import('../services/start-staging.js')>(
    '../services/start-staging.js',
  );
  return { ...actual, startStaging: mocks.startStaging };
});

import { stagingRoutes } from './staging.js';
import { AppNotFoundError } from '../services/app-resolver.js';

function build() {
  const app = Fastify();
  app.decorate('controlDb', {} as never);
  app.addHook('onRequest', async (req) => {
    (req as never as { auth: unknown }).auth = { userId: 'u1', organizationId: 'org_1' };
  });
  app.register(stagingRoutes);
  return app;
}

function fakeRuntimeDb() {
  return {
    query: vi.fn(async (sql: string, params: unknown[]) => {
      const id = (params as string[])[0];
      if (id === 'app_prod') return { rows: [{ db_name: 'db_prod' }] };
      if (id === 'app_staging') return { rows: [{ db_name: 'db_staging' }] };
      return { rows: [] };
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveOrganizationId.mockResolvedValue('org_1');
  mocks.resolveApp.mockResolvedValue({ id: 'app_prod', owner_id: 'u1' });
  mocks.resolveAppHomeRegion.mockResolvedValue('us-east-1');
  mocks.getRuntimeDbForApp.mockResolvedValue(fakeRuntimeDb());
  mocks.getEnvironmentLink.mockResolvedValue({ staging_app_id: 'app_staging' });
  mocks.getAppPoolForApp.mockResolvedValue({});
  // Promote is deliberately NOT gated on features.staging — blocking it
  // would strand a downgraded user's work inside staging with no way to get
  // it out. A plan that lacks the feature entirely must not affect promote.
  mocks.getAppPlanFeatures.mockResolvedValue({});
});

describe('GET /v1/apps/:app_id/staging/promote/preview', () => {
  it('reports a clean preview', async () => {
    mocks.buildPromotePreview.mockResolvedValue({
      additive: [{ sql: 'CREATE TABLE "n" ()' }], blocked: [], canPromote: true, ignoredRemovals: [],
    });
    const res = await build().inject({
      method: 'GET', url: '/v1/apps/app_prod/staging/promote/preview',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      can_promote: true, additive: ['CREATE TABLE "n" ()'], blocked: [], ignored_removals: [],
    });
  });

  it('reports blocked statements and ignored removals without starting a job', async () => {
    mocks.buildPromotePreview.mockResolvedValue({
      additive: [],
      blocked: [{ sql: 'ALTER TABLE "n" DROP COLUMN "x"' }],
      canPromote: false,
      ignoredRemovals: ['table "old_table"'],
    });
    const res = await build().inject({
      method: 'GET', url: '/v1/apps/app_prod/staging/promote/preview',
    });
    expect(res.json()).toEqual({
      can_promote: false,
      additive: [],
      blocked: ['ALTER TABLE "n" DROP COLUMN "x"'],
      ignored_removals: ['table "old_table"'],
    });
    expect(mocks.enqueueCloneTask).not.toHaveBeenCalled();
  });

  it('reports no staging environment without introspecting anything', async () => {
    mocks.getEnvironmentLink.mockResolvedValue(null);
    const res = await build().inject({
      method: 'GET', url: '/v1/apps/app_prod/staging/promote/preview',
    });
    expect(res.json()).toEqual({ can_promote: false, additive: [], blocked: [], ignored_removals: [] });
    expect(mocks.buildPromotePreview).not.toHaveBeenCalled();
  });

  it('returns 404 and never builds a preview when the caller does not own the app', async () => {
    mocks.resolveApp.mockRejectedValue(new AppNotFoundError('app_prod'));
    const res = await build().inject({
      method: 'GET', url: '/v1/apps/app_prod/staging/promote/preview',
    });
    expect(res.statusCode).toBe(404);
    expect(mocks.buildPromotePreview).not.toHaveBeenCalled();
    expect(mocks.getEnvironmentLink).not.toHaveBeenCalled();
  });
});

describe('POST /v1/apps/:app_id/staging/promote', () => {
  it('enqueues the promote job against the staging app in the production region', async () => {
    mocks.startPromote.mockResolvedValue({ ok: true, jobId: 'job_p1' });
    const res = await build().inject({ method: 'POST', url: '/v1/apps/app_prod/staging/promote' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ job_id: 'job_p1', status: 'pending' });
    expect(mocks.enqueueCloneTask).toHaveBeenCalledWith('app_staging', 'us-east-1', 'job_p1');
  });

  it('is not gated on features.staging — succeeds even when the plan lacks the feature', async () => {
    mocks.getAppPlanFeatures.mockResolvedValue({ staging: false });
    mocks.startPromote.mockResolvedValue({ ok: true, jobId: 'job_p2' });
    const res = await build().inject({ method: 'POST', url: '/v1/apps/app_prod/staging/promote' });
    expect(res.statusCode).toBe(200);
    expect(mocks.enqueueCloneTask).toHaveBeenCalledWith('app_staging', 'us-east-1', 'job_p2');
  });

  it('returns 409 with the blocked message verbatim and enqueues nothing', async () => {
    mocks.startPromote.mockResolvedValue({
      ok: false, code: 'BLOCKED', message: 'Promote refused: ... DROP COLUMN "x"',
    });
    const res = await build().inject({ method: 'POST', url: '/v1/apps/app_prod/staging/promote' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain('DROP COLUMN "x"');
    expect(mocks.enqueueCloneTask).not.toHaveBeenCalled();
  });

  it('maps an unhandled throw from startPromote to a clean 500', async () => {
    mocks.startPromote.mockRejectedValue(new Error('deleteCloneJob failed too'));
    const res = await build().inject({ method: 'POST', url: '/v1/apps/app_prod/staging/promote' });
    expect(res.statusCode).toBe(500);
    expect(res.json().error.message).not.toContain('deleteCloneJob failed too');
    expect(mocks.enqueueCloneTask).not.toHaveBeenCalled();
  });

  it('returns 404 and never starts a promote when the caller does not own the app', async () => {
    mocks.resolveApp.mockRejectedValue(new AppNotFoundError('app_prod'));
    const res = await build().inject({ method: 'POST', url: '/v1/apps/app_prod/staging/promote' });
    expect(res.statusCode).toBe(404);
    expect(mocks.startPromote).not.toHaveBeenCalled();
    expect(mocks.enqueueCloneTask).not.toHaveBeenCalled();
  });
});
