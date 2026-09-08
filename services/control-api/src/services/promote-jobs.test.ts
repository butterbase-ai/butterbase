import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getEnvironmentLink: vi.fn(),
  buildPromotePreview: vi.fn(),
  createCloneJob: vi.fn(),
  deleteCloneJob: vi.fn(),
  getAppPoolForApp: vi.fn(),
  getRuntimeDbForApp: vi.fn(),
  resolveAppHomeRegion: vi.fn(),
}));

vi.mock('./app-environments.js', () => ({ getEnvironmentLink: mocks.getEnvironmentLink }));
vi.mock('./promote-preview.js', async () => {
  const actual = await vi.importActual<typeof import('./promote-preview.js')>('./promote-preview.js');
  return { ...actual, buildPromotePreview: mocks.buildPromotePreview };
});
vi.mock('./clone-jobs.js', async () => {
  const actual = await vi.importActual<typeof import('./clone-jobs.js')>('./clone-jobs.js');
  return { ...actual, createCloneJob: mocks.createCloneJob, deleteCloneJob: mocks.deleteCloneJob };
});
vi.mock('./app-pool.js', () => ({ getAppPoolForApp: mocks.getAppPoolForApp }));
vi.mock('./region-resolver.js', () => ({
  getRuntimeDbForApp: mocks.getRuntimeDbForApp,
  resolveAppHomeRegion: mocks.resolveAppHomeRegion,
}));

import { startPromote } from './promote-jobs.js';

function makeControlDb(rows: unknown[] = []) {
  return { query: vi.fn().mockResolvedValue({ rows }) } as never;
}

const baseArgs = {
  prodAppId: 'app_prod',
  userId: 'u1',
  orgId: 'org_1',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getRuntimeDbForApp.mockResolvedValue({ query: vi.fn().mockResolvedValue({ rows: [{ db_name: 'db_prod', region: 'us-east-1' }] }) });
  mocks.resolveAppHomeRegion.mockResolvedValue('us-east-1');
  mocks.getEnvironmentLink.mockResolvedValue({ staging_app_id: 'app_staging' });
  mocks.getAppPoolForApp.mockResolvedValue({});
  mocks.buildPromotePreview.mockResolvedValue({ additive: [], blocked: [], canPromote: true, ignoredRemovals: [] });
  mocks.createCloneJob.mockResolvedValue({ id: 'job_p1' });
});

describe('startPromote', () => {
  it('creates a promote job when the preview is clean', async () => {
    const res = await startPromote({ ...baseArgs, controlDb: makeControlDb([]) });
    expect(res).toMatchObject({ ok: true, jobId: 'job_p1' });
    expect(mocks.createCloneJob).toHaveBeenCalled();
  });

  it('refuses when the app has no staging environment', async () => {
    mocks.getEnvironmentLink.mockResolvedValue(null);
    const res = await startPromote({ ...baseArgs, controlDb: makeControlDb([]) });
    expect(res).toMatchObject({ ok: false, code: 'NO_STAGING' });
    expect(mocks.createCloneJob).not.toHaveBeenCalled();
  });

  it('refuses and names the blocked statements', async () => {
    mocks.buildPromotePreview.mockResolvedValue({
      additive: [],
      blocked: [{ kind: 'drop_column', sql: 'ALTER TABLE "n" DROP COLUMN "x"', destructive: true }],
      canPromote: false,
      ignoredRemovals: [],
    });
    const res = await startPromote({ ...baseArgs, controlDb: makeControlDb([]) });
    expect(res).toMatchObject({ ok: false, code: 'BLOCKED' });
    expect((res as { message: string }).message).toContain('DROP COLUMN "x"');
    expect(mocks.createCloneJob).not.toHaveBeenCalled();
  });

  it('refuses a second in-flight promote for the same app', async () => {
    const controlDb = makeControlDb([{ id: 'job_existing' }]);
    const res = await startPromote({ ...baseArgs, controlDb });
    expect(res).toMatchObject({ ok: false, code: 'IN_FLIGHT' });
    expect(mocks.createCloneJob).not.toHaveBeenCalled();
  });
});
