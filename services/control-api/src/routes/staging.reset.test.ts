import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

const mocks = vi.hoisted(() => ({
  startStagingReset: vi.fn(),
  enqueueCloneTask: vi.fn(),
  resolveAppHomeRegion: vi.fn(),
  resolveOrganizationId: vi.fn(),
  resolveApp: vi.fn(),
  // Route also imports these for the other existing staging endpoints —
  // stub them so importing staging.js does not blow up.
  getEnvironmentLink: vi.fn(),
  unlinkEnvironment: vi.fn(),
  getRuntimeDbForApp: vi.fn(),
  startStaging: vi.fn(),
  startPromote: vi.fn(),
  buildPromotePreview: vi.fn(),
  getAppPoolForApp: vi.fn(),
}));

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
  mocks.resolveOrganizationId.mockResolvedValue('org_1');
  mocks.resolveApp.mockResolvedValue({ id: 'app_prod', owner_id: 'u1' });
  mocks.resolveAppHomeRegion.mockResolvedValue('us-east-1');
});

describe('POST /v1/apps/:app_id/staging/reset', () => {
  it('enqueues the reset job against the PRODUCTION app in the production region', async () => {
    mocks.startStagingReset.mockResolvedValue({
      ok: true, jobId: 'job_r1', stagingAppId: 'app_staging',
    });
    const res = await build().inject({ method: 'POST', url: '/v1/apps/app_prod/staging/reset' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ job_id: 'job_r1', status: 'pending' });
    // Direction: the enqueued task's source app must be PRODUCTION
    // (app_prod), not staging — enqueueCloneTask's first argument is the
    // source app id, and neon_tasks is a per-region queue the worker claims
    // from its own instanceRegion, so this must land in production's region.
    expect(mocks.enqueueCloneTask).toHaveBeenCalledWith('app_prod', 'us-east-1', 'job_r1');
  });

  it('returns 404 with the NO_STAGING message and enqueues nothing', async () => {
    mocks.startStagingReset.mockResolvedValue({
      ok: false, code: 'NO_STAGING', message: 'This app has no staging environment to reset.',
    });
    const res = await build().inject({ method: 'POST', url: '/v1/apps/app_prod/staging/reset' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.message).toBe('This app has no staging environment to reset.');
    expect(mocks.enqueueCloneTask).not.toHaveBeenCalled();
  });

  it('returns 404 and never calls startStagingReset when the caller does not own the app', async () => {
    mocks.resolveApp.mockRejectedValue(new AppNotFoundError('app_prod'));
    const res = await build().inject({ method: 'POST', url: '/v1/apps/app_prod/staging/reset' });
    expect(res.statusCode).toBe(404);
    expect(mocks.startStagingReset).not.toHaveBeenCalled();
    expect(mocks.enqueueCloneTask).not.toHaveBeenCalled();
  });

  // Fix round 3, item 2: startStagingReset's IN_FLIGHT refusal (a promote is
  // running) must reach the caller as 409, distinct from NO_STAGING's 404 —
  // and must never enqueue.
  it('returns 409 with the IN_FLIGHT message and enqueues nothing', async () => {
    mocks.startStagingReset.mockResolvedValue({
      ok: false, code: 'IN_FLIGHT',
      message: 'A promote is currently running for this app. Wait for it to finish before '
        + 'resetting staging.',
    });
    const res = await build().inject({ method: 'POST', url: '/v1/apps/app_prod/staging/reset' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain('promote is currently running');
    expect(mocks.enqueueCloneTask).not.toHaveBeenCalled();
  });

  // Reset's own in-flight guard (this fix round): a second reset for the same
  // app must reach the caller as 409, distinct from both NO_STAGING's 404 and
  // the promote-blocks-reset IN_FLIGHT case above — and must never enqueue.
  it('returns 409 with the RESET_IN_FLIGHT message and enqueues nothing', async () => {
    mocks.startStagingReset.mockResolvedValue({
      ok: false, code: 'RESET_IN_FLIGHT',
      message: 'A reset is already running for this app. Wait for it to finish.',
    });
    const res = await build().inject({ method: 'POST', url: '/v1/apps/app_prod/staging/reset' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain('reset is already running');
    expect(mocks.enqueueCloneTask).not.toHaveBeenCalled();
  });
});
