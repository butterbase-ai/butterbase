import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

const mocks = vi.hoisted(() => ({
  startStaging: vi.fn(),
  getEnvironmentLink: vi.fn(),
  getEnvironmentLinkWithPauseState: vi.fn(),
  unlinkEnvironment: vi.fn(),
  enqueueCloneTask: vi.fn(),
  getRuntimeDbForApp: vi.fn(),
  resolveOrganizationId: vi.fn(),
  resolveApp: vi.fn(),
  getLatestStagingJob: vi.fn(),
  getAppPlanFeatures: vi.fn(),
}));

vi.mock('../services/start-staging.js', async () => {
  const actual = await vi.importActual<typeof import('../services/start-staging.js')>(
    '../services/start-staging.js',
  );
  return { ...actual, startStaging: mocks.startStaging };
});
vi.mock('../services/plan-features.js', () => ({
  getAppPlanFeatures: mocks.getAppPlanFeatures,
}));
vi.mock('../services/app-environments.js', () => ({
  getEnvironmentLink: mocks.getEnvironmentLink,
  getEnvironmentLinkWithPauseState: mocks.getEnvironmentLinkWithPauseState,
  unlinkEnvironment: mocks.unlinkEnvironment,
}));
vi.mock('../services/clone-jobs.js', () => ({
  getLatestStagingJob: mocks.getLatestStagingJob,
}));
vi.mock('../services/clone-task-queue.js', () => ({ enqueueCloneTask: mocks.enqueueCloneTask }));
vi.mock('../services/region-resolver.js', () => ({ getRuntimeDbForApp: mocks.getRuntimeDbForApp }));
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

import { stagingRoutes } from './staging.js';
import { AppNotFoundError } from '../services/app-resolver.js';
import { quotaErrors } from '../utils/quota-errors.js';

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
  mocks.getRuntimeDbForApp.mockResolvedValue({});
  mocks.resolveApp.mockResolvedValue({ id: 'app_prod', owner_id: 'u1' });
  mocks.getLatestStagingJob.mockResolvedValue(null);
  mocks.getAppPlanFeatures.mockResolvedValue({ staging: true });
});

describe('POST /v1/apps/:app_id/staging', () => {
  it('enqueues the task only after the control-plane write succeeded', async () => {
    mocks.startStaging.mockResolvedValue({
      ok: true, jobId: 'job_1', stagingName: 'my-crm-staging', stagingSubdomain: 'my-crm-staging', region: 'us-east-1',
    });
    const app = build();
    const res = await app.inject({ method: 'POST', url: '/v1/apps/app_prod/staging' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ job_id: 'job_1', staging_name: 'my-crm-staging', staging_subdomain: 'my-crm-staging' });
    expect(mocks.enqueueCloneTask).toHaveBeenCalledWith('app_prod', 'us-east-1', 'job_1');
  });

  it('returns 409 and does not enqueue when staging already exists', async () => {
    mocks.startStaging.mockResolvedValue({
      ok: false, code: 'ALREADY_EXISTS', stagingAppId: 'app_staging',
    });
    const app = build();
    const res = await app.inject({ method: 'POST', url: '/v1/apps/app_prod/staging' });
    expect(res.statusCode).toBe(409);
    expect(mocks.enqueueCloneTask).not.toHaveBeenCalled();
  });

  it('returns 404 and never calls startStaging when the caller does not own the app', async () => {
    mocks.resolveApp.mockRejectedValue(new AppNotFoundError('app_prod'));
    const app = build();
    const res = await app.inject({ method: 'POST', url: '/v1/apps/app_prod/staging' });
    expect(res.statusCode).toBe(404);
    expect(mocks.startStaging).not.toHaveBeenCalled();
    expect(mocks.enqueueCloneTask).not.toHaveBeenCalled();
  });

  it('refuses with 403 when the plan lacks the staging feature', async () => {
    mocks.getAppPlanFeatures.mockResolvedValue({ staging: false });
    const app = build();
    const res = await app.inject({ method: 'POST', url: '/v1/apps/app_prod/staging' });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual(quotaErrors.featureNotAvailable('staging'));
  });

  it('writes no clone job row when the plan lacks the staging feature', async () => {
    // The refusal must land before ANY side effect: no clone job row, no
    // queued task. startStaging is what performs the control-plane write
    // that creates the clone job row, and enqueueCloneTask is what queues
    // the worker task for it — neither must be called on refusal.
    mocks.getAppPlanFeatures.mockResolvedValue({});
    const app = build();
    const res = await app.inject({ method: 'POST', url: '/v1/apps/app_prod/staging' });
    expect(res.statusCode).toBe(403);
    expect(mocks.startStaging).not.toHaveBeenCalled();
    expect(mocks.enqueueCloneTask).not.toHaveBeenCalled();
  });

  it('allows staging creation to proceed end to end when the plan has the feature', async () => {
    mocks.getAppPlanFeatures.mockResolvedValue({ staging: true });
    mocks.startStaging.mockResolvedValue({
      ok: true, jobId: 'job_2', stagingName: 'my-crm-staging', stagingSubdomain: 'my-crm-staging', region: 'us-east-1',
    });
    const app = build();
    const res = await app.inject({ method: 'POST', url: '/v1/apps/app_prod/staging' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ job_id: 'job_2', staging_name: 'my-crm-staging' });
    expect(mocks.enqueueCloneTask).toHaveBeenCalledWith('app_prod', 'us-east-1', 'job_2');
  });

  it('returns 404, not 403, when a non-owner calls with a plan that lacks staging — ownership beats the gate', async () => {
    mocks.resolveApp.mockRejectedValue(new AppNotFoundError('app_prod'));
    mocks.getAppPlanFeatures.mockResolvedValue({ staging: false });
    const app = build();
    const res = await app.inject({ method: 'POST', url: '/v1/apps/app_prod/staging' });
    expect(res.statusCode).toBe(404);
    expect(mocks.getAppPlanFeatures).not.toHaveBeenCalled();
    expect(mocks.startStaging).not.toHaveBeenCalled();
  });
});

describe('GET /v1/apps/:app_id/staging', () => {
  it('reports null when there is no staging environment', async () => {
    mocks.getEnvironmentLinkWithPauseState.mockResolvedValue(null);
    const app = build();
    const res = await app.inject({ method: 'GET', url: '/v1/apps/app_prod/staging' });
    expect(res.json()).toEqual({ staging_app_id: null });
  });

  it('returns the link, unpaused, when one exists and the staging app is not paused', async () => {
    mocks.getEnvironmentLinkWithPauseState.mockResolvedValue({
      staging_app_id: 'app_staging',
      created_at: new Date('2026-09-08T00:00:00Z'),
      last_promoted_at: null,
      last_reset_at: null,
      staging_paused: false,
      staging_paused_at: null,
      staging_paused_reason: null,
    });
    const app = build();
    const res = await app.inject({ method: 'GET', url: '/v1/apps/app_prod/staging' });
    const body = res.json();
    expect(body).toMatchObject({
      staging_app_id: 'app_staging',
      last_promoted_at: null,
      paused: false,
      paused_at: null,
      paused_reason: null,
    });
  });

  it('reports paused fields and why, when the staging app has been paused', async () => {
    mocks.getEnvironmentLinkWithPauseState.mockResolvedValue({
      staging_app_id: 'app_staging',
      created_at: new Date('2026-09-08T00:00:00Z'),
      last_promoted_at: null,
      last_reset_at: null,
      staging_paused: true,
      staging_paused_at: new Date('2026-09-09T00:00:00Z'),
      staging_paused_reason: 'Automatically paused after 30 days of inactivity.',
    });
    const app = build();
    const res = await app.inject({ method: 'GET', url: '/v1/apps/app_prod/staging' });
    const body = res.json();
    expect(body.paused).toBe(true);
    expect(body.paused_at).toBe('2026-09-09T00:00:00.000Z');
    expect(body.paused_reason).toBe('Automatically paused after 30 days of inactivity.');
  });

  it('points at the most recent staging job, not an unrelated clone job for the same app', async () => {
    mocks.getEnvironmentLinkWithPauseState.mockResolvedValue({
      staging_app_id: 'app_staging',
      created_at: new Date('2026-09-08T00:00:00Z'),
      last_promoted_at: null,
      last_reset_at: null,
      staging_paused: false,
      staging_paused_at: null,
      staging_paused_reason: null,
    });
    mocks.getLatestStagingJob.mockResolvedValue({
      job_id: 'job_reset_2',
      mode: 'staging_reset',
      status: 'completed',
      created_at: new Date('2026-09-09T01:00:00Z'),
    });
    const app = build();
    const res = await app.inject({ method: 'GET', url: '/v1/apps/app_prod/staging' });
    const body = res.json();
    expect(body.last_job).toEqual({
      job_id: 'job_reset_2',
      mode: 'staging_reset',
      status: 'completed',
      created_at: '2026-09-09T01:00:00.000Z',
    });
    expect(mocks.getLatestStagingJob).toHaveBeenCalledWith({}, 'app_prod');
  });

  it('reports last_job: null when there is no staging job yet', async () => {
    mocks.getEnvironmentLinkWithPauseState.mockResolvedValue({
      staging_app_id: 'app_staging',
      created_at: new Date('2026-09-08T00:00:00Z'),
      last_promoted_at: null,
      last_reset_at: null,
      staging_paused: false,
      staging_paused_at: null,
      staging_paused_reason: null,
    });
    mocks.getLatestStagingJob.mockResolvedValue(null);
    const app = build();
    const res = await app.inject({ method: 'GET', url: '/v1/apps/app_prod/staging' });
    expect(res.json().last_job).toBeNull();
  });

  it('returns 404 and never reads the link when the caller does not own the app', async () => {
    mocks.resolveApp.mockRejectedValue(new AppNotFoundError('app_prod'));
    const app = build();
    const res = await app.inject({ method: 'GET', url: '/v1/apps/app_prod/staging' });
    expect(res.statusCode).toBe(404);
    expect(mocks.getEnvironmentLinkWithPauseState).not.toHaveBeenCalled();
  });
});

describe('DELETE /v1/apps/:app_id/staging', () => {
  it('unlinks without deleting the staging app, and names what it left behind', async () => {
    mocks.getEnvironmentLink.mockResolvedValue({
      staging_app_id: 'app_staging',
      created_at: new Date('2026-09-08T00:00:00Z'),
      last_promoted_at: null,
      last_reset_at: null,
    });
    mocks.unlinkEnvironment.mockResolvedValue(undefined);
    const app = build();
    const res = await app.inject({ method: 'DELETE', url: '/v1/apps/app_prod/staging' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.deleted).toBe(true);
    expect(mocks.unlinkEnvironment).toHaveBeenCalledWith({}, 'app_prod');

    // The staging app survives an unlink and still holds a copy of
    // production's rows, auth users and files. That retention must be stated,
    // not implied — and it must name the app id and the call that removes it,
    // because after this response nothing else points at the orphaned app.
    expect(body.retained_staging_app_id).toBe('app_staging');
    expect(body.retention_notice).toContain('app_staging');
    expect(body.retention_notice).toContain('DELETE /apps/app_staging');
  });

  it('reports no retained app when there was no link to remove', async () => {
    mocks.getEnvironmentLink.mockResolvedValue(null);
    mocks.unlinkEnvironment.mockResolvedValue(undefined);
    const app = build();
    const res = await app.inject({ method: 'DELETE', url: '/v1/apps/app_prod/staging' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted: true, retained_staging_app_id: null });
  });

  it('returns 404 and never unlinks when the caller does not own the app', async () => {
    mocks.resolveApp.mockRejectedValue(new AppNotFoundError('app_prod'));
    const app = build();
    const res = await app.inject({ method: 'DELETE', url: '/v1/apps/app_prod/staging' });
    expect(res.statusCode).toBe(404);
    expect(mocks.unlinkEnvironment).not.toHaveBeenCalled();
  });
});
