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

/**
 * Distinguishes the prod-app row lookup from the staging-app row lookup by
 * the id param, so tests can set the staging app's repo_latest_snapshot
 * independently of the prod row's db_name/region — startPromote queries the
 * same runtimeDb pool for both (staging is pinned to production's region).
 */
function makeRuntimeDb(opts: { stagingSnapshot?: string | null } = {}) {
  const stagingSnapshot = opts.stagingSnapshot === undefined ? 'snap_stage_1' : opts.stagingSnapshot;
  return {
    query: vi.fn(async (_sql: string, params: unknown[] = []) => {
      const id = params[0];
      if (id === 'app_staging') {
        return { rows: [{ db_name: 'db_staging', repo_latest_snapshot: stagingSnapshot }] };
      }
      // app_prod, or anything else.
      return { rows: [{ db_name: 'db_prod', region: 'us-east-1' }] };
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getRuntimeDbForApp.mockResolvedValue(makeRuntimeDb());
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

  // Fix round 1: source_snapshot_id must be the staging app's REAL repo
  // pointer, pinned at request time — not the old synthetic
  // `promote:<app>:<ts>` placeholder, which pinned nothing in
  // listActiveCloneSnapshotIdsForApp's retention guard.
  it("pins the staging app's real repo_latest_snapshot as the job's source_snapshot_id", async () => {
    mocks.getRuntimeDbForApp.mockResolvedValue(makeRuntimeDb({ stagingSnapshot: 'snap_stage_1' }));
    const res = await startPromote({ ...baseArgs, controlDb: makeControlDb([]) });
    expect(res).toMatchObject({ ok: true, jobId: 'job_p1' });
    expect(mocks.createCloneJob).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sourceAppId: 'app_staging', sourceSnapshotId: 'snap_stage_1' }),
    );
  });

  // Deliberate, not a refusal: a staging app that has never had a repo push
  // (cloned from a repo-less template, or nothing pushed yet) can still be
  // promoted — schema/RLS/functions/config travel, execute-promote.ts's
  // 'repo' step just skips with a warning. Pinned end-to-end here so the
  // chosen behaviour (record null, don't refuse) doesn't drift back into a
  // hard failure.
  it('creates the job with a null source_snapshot_id when staging has no repo yet, without refusing', async () => {
    mocks.getRuntimeDbForApp.mockResolvedValue(makeRuntimeDb({ stagingSnapshot: null }));
    const res = await startPromote({ ...baseArgs, controlDb: makeControlDb([]) });
    expect(res).toMatchObject({ ok: true, jobId: 'job_p1' });
    expect(mocks.createCloneJob).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sourceAppId: 'app_staging', sourceSnapshotId: null }),
    );
  });
});
