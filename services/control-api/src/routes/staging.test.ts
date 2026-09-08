import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

const mocks = vi.hoisted(() => ({
  startStaging: vi.fn(),
  getEnvironmentLink: vi.fn(),
  unlinkEnvironment: vi.fn(),
  enqueueCloneTask: vi.fn(),
  getRuntimeDbForApp: vi.fn(),
  resolveOrganizationId: vi.fn(),
  resolveApp: vi.fn(),
}));

vi.mock('../services/start-staging.js', async () => {
  const actual = await vi.importActual<typeof import('../services/start-staging.js')>(
    '../services/start-staging.js',
  );
  return { ...actual, startStaging: mocks.startStaging };
});
vi.mock('../services/app-environments.js', () => ({
  getEnvironmentLink: mocks.getEnvironmentLink,
  unlinkEnvironment: mocks.unlinkEnvironment,
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
});

describe('GET /v1/apps/:app_id/staging', () => {
  it('reports null when there is no staging environment', async () => {
    mocks.getEnvironmentLink.mockResolvedValue(null);
    const app = build();
    const res = await app.inject({ method: 'GET', url: '/v1/apps/app_prod/staging' });
    expect(res.json()).toEqual({ staging_app_id: null });
  });

  it('returns the link when one exists', async () => {
    mocks.getEnvironmentLink.mockResolvedValue({
      staging_app_id: 'app_staging',
      created_at: new Date('2026-09-08T00:00:00Z'),
      last_promoted_at: null,
      last_reset_at: null,
    });
    const app = build();
    const res = await app.inject({ method: 'GET', url: '/v1/apps/app_prod/staging' });
    expect(res.json()).toMatchObject({ staging_app_id: 'app_staging', last_promoted_at: null });
  });

  it('returns 404 and never reads the link when the caller does not own the app', async () => {
    mocks.resolveApp.mockRejectedValue(new AppNotFoundError('app_prod'));
    const app = build();
    const res = await app.inject({ method: 'GET', url: '/v1/apps/app_prod/staging' });
    expect(res.statusCode).toBe(404);
    expect(mocks.getEnvironmentLink).not.toHaveBeenCalled();
  });
});

describe('DELETE /v1/apps/:app_id/staging', () => {
  it('unlinks without deleting the staging app, and names what it left behind', async () => {
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
