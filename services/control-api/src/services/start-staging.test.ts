import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getEnvironmentLink: vi.fn(),
  getLinkByStagingApp: vi.fn(),
  startClone: vi.fn(),
  getRuntimeDbForApp: vi.fn(),
  allocateStagingSubdomain: vi.fn(),
}));

vi.mock('./app-environments.js', () => ({
  getEnvironmentLink: mocks.getEnvironmentLink,
  getLinkByStagingApp: mocks.getLinkByStagingApp,
}));
vi.mock('./start-clone.js', () => ({ startClone: mocks.startClone }));
vi.mock('./region-resolver.js', () => ({ getRuntimeDbForApp: mocks.getRuntimeDbForApp }));
vi.mock('./staging-naming.js', async () => {
  const actual = await vi.importActual<typeof import('./staging-naming.js')>('./staging-naming.js');
  return {
    deriveStagingName: actual.deriveStagingName,
    allocateStagingSubdomain: mocks.allocateStagingSubdomain,
  };
});

import { startStaging } from './start-staging.js';

const controlDbQuery = vi.fn().mockResolvedValue({ rows: [] });

const baseArgs = {
  controlDb: { query: controlDbQuery } as never,
  prodAppId: 'app_prod',
  userId: '00000000-0000-0000-0000-0000000000e1',
  orgId: 'org_1',
  logger: { warn: () => {} },
};

// getRuntimeDbForApp resolves to a plain pg.Pool (see region-resolver.ts) —
// not a { pool, region } wrapper. Region for a given app comes from the
// `apps` row itself, exactly as start-clone.ts does it.
function fakeRuntimePool(rows: Array<{ name: string; region: string; subdomain: string | null }>) {
  return { query: vi.fn().mockResolvedValue({ rows }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  controlDbQuery.mockClear();
  controlDbQuery.mockResolvedValue({ rows: [] });
  mocks.getEnvironmentLink.mockResolvedValue(null);
  mocks.getLinkByStagingApp.mockResolvedValue(null);
  mocks.getRuntimeDbForApp.mockResolvedValue(
    fakeRuntimePool([{ name: 'my-crm', region: 'us-east-1', subdomain: 'my-crm' }]),
  );
  mocks.allocateStagingSubdomain.mockResolvedValue('my-crm-staging');
  mocks.startClone.mockResolvedValue({
    ok: true, jobId: 'job_1', destAppId: null, sourceAppId: 'app_prod',
    sourceRegion: 'us-east-1', destRegion: 'us-east-1',
  });
});

describe('startStaging', () => {
  it('starts a clone pinned to the production app region', async () => {
    const res = await startStaging(baseArgs);
    expect(res.ok).toBe(true);
    expect(mocks.startClone).toHaveBeenCalledWith(
      expect.objectContaining({ destRegion: 'us-east-1', name: 'my-crm-staging' }),
    );
  });

  it('refuses when the app already has a staging environment', async () => {
    mocks.getEnvironmentLink.mockResolvedValue({ staging_app_id: 'app_staging' });
    const res = await startStaging(baseArgs);
    expect(res).toMatchObject({ ok: false, code: 'ALREADY_EXISTS', stagingAppId: 'app_staging' });
    expect(mocks.startClone).not.toHaveBeenCalled();
  });

  it('refuses to create a staging environment of a staging app', async () => {
    mocks.getLinkByStagingApp.mockResolvedValue({ prod_app_id: 'app_other' });
    const res = await startStaging(baseArgs);
    expect(res).toMatchObject({ ok: false, code: 'IS_STAGING' });
    expect(mocks.startClone).not.toHaveBeenCalled();
  });

  it('surfaces a clone refusal rather than swallowing it', async () => {
    mocks.startClone.mockResolvedValue({ ok: false, code: 'QUOTA_EXCEEDED', current: 5, limit: 5 });
    const res = await startStaging(baseArgs);
    expect(res).toMatchObject({ ok: false, code: 'CLONE_REFUSED' });
  });

  it('refuses when the production app does not exist', async () => {
    mocks.getRuntimeDbForApp.mockResolvedValue(fakeRuntimePool([]));
    const res = await startStaging(baseArgs);
    expect(res).toMatchObject({ ok: false, code: 'PROD_NOT_FOUND' });
  });

  // --- Mandatory deviation from the brief: allocateStagingSubdomain must
  // actually be called, not deriveStagingName alone, because apps.subdomain
  // carries a global unique index and an unrelated app may already hold
  // "<name>-staging".

  it('calls allocateStagingSubdomain with the prod app subdomain and returns it as stagingSubdomain', async () => {
    mocks.allocateStagingSubdomain.mockResolvedValue('my-crm-staging-3');
    const res = await startStaging(baseArgs);
    expect(mocks.allocateStagingSubdomain).toHaveBeenCalledWith(
      expect.anything(), 'my-crm',
    );
    expect(res).toMatchObject({ ok: true, stagingSubdomain: 'my-crm-staging-3' });
  });

  it('returns NO_SUBDOMAIN when allocateStagingSubdomain exhausts its attempts, without calling startClone', async () => {
    mocks.allocateStagingSubdomain.mockRejectedValue(
      new Error('No free subdomain for staging of "my-crm" after 10 attempts.'),
    );
    const res = await startStaging(baseArgs);
    expect(res).toMatchObject({ ok: false, code: 'NO_SUBDOMAIN' });
    expect(mocks.startClone).not.toHaveBeenCalled();
  });

  it('falls back to deriving the subdomain from the app name when apps.subdomain is NULL', async () => {
    mocks.getRuntimeDbForApp.mockResolvedValue(
      fakeRuntimePool([{ name: 'my-crm', region: 'us-east-1', subdomain: null }]),
    );
    const res = await startStaging(baseArgs);
    expect(mocks.allocateStagingSubdomain).toHaveBeenCalledWith(expect.anything(), 'my-crm');
    expect(res.ok).toBe(true);
  });
});
