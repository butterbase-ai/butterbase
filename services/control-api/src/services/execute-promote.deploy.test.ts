/**
 * Task 14: promote publishes the staging repo snapshot onto production and
 * redeploys the production frontend from it — the two arms Task 13 left as
 * deliberate no-ops (see the 'repo'/'frontend' case in execute-promote.ts).
 *
 * Two real dependencies, verified against the actual tree rather than
 * guessed:
 *   - Repo publish reuses the SAME primitives executeClone/executeUpdate use
 *     (repo-storage.ts: getManifestJson, copyBlobSameRegion,
 *     copyManifestSameRegion, setLatest) plus a raw UPDATE of
 *     apps.repo_latest_snapshot. There is no single "publish repo" helper.
 *   - Frontend deploy reuses replayFrontend from clone-replay.ts — NOT a
 *     `deployFrontend` from deployment.service.js, which does not exist.
 *     replayFrontend normally SOFT-FAILS (warnings, job still completes);
 *     promote needs it to throw, so it gains an opt-in `throwOnFailure` flag.
 *
 * Fix round 1: the 'repo' step uses job.source_snapshot_id, PINNED AT REQUEST
 * TIME by startPromote (promote-jobs.ts), not re-read from staging's live
 * apps.repo_latest_snapshot at execution time. That fixed value is what makes
 * listActiveCloneSnapshotIdsForApp's retention pin protect the snapshot this
 * step is about to copy — a synthetic placeholder pinned nothing. NULL is a
 * legitimate value (staging had no repo at request time): the step skips
 * with a job warning rather than refusing the whole promote, since a
 * backend-only promote is legitimate.
 *
 * Fix round 2:
 *   - throwOnFailure itself is unit-tested directly against replayFrontend in
 *     clone-replay.replay-frontend.test.ts, not just through this file's
 *     mocked replayFrontend (a mutation test showed the tests here alone
 *     don't prove the flag does anything).
 *   - For the default 'pages' backend, a 'completed' promote means the
 *     deploy was SUBMITTED and is still building — not live. The 'frontend'
 *     step now reads apps.deployment_backend and attaches a warning saying
 *     so, unless the backend is 'wfp' (synchronous, terminal).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  replaySchema: vi.fn(),
  replayRls: vi.fn(),
  replayFunctions: vi.fn(),
  replayNonSecretConfig: vi.fn(),
  replaySeedData: vi.fn(),
  replayFrontend: vi.fn(),
  replayDurableObjectsForClone: vi.fn(),
  setCloneJobStatus: vi.fn(),
  appendCloneJobWarnings: vi.fn(),
  touchEnvironmentTimestamp: vi.fn(),
  getManifestJson: vi.fn(),
  copyBlobSameRegion: vi.fn(),
  copyManifestSameRegion: vi.fn(),
  setLatest: vi.fn(),
}));

vi.mock('./clone-replay.js', () => ({
  replaySchema: mocks.replaySchema,
  replayRls: mocks.replayRls,
  replayFunctions: mocks.replayFunctions,
  replayNonSecretConfig: mocks.replayNonSecretConfig,
  replaySeedData: mocks.replaySeedData,
  replayFrontend: mocks.replayFrontend,
}));
vi.mock('./durable-objects.service.js', () => ({
  replayDurableObjectsForClone: mocks.replayDurableObjectsForClone,
}));
vi.mock('./clone-jobs.js', () => ({
  setCloneJobStatus: mocks.setCloneJobStatus,
  appendCloneJobWarnings: mocks.appendCloneJobWarnings,
}));
vi.mock('./app-environments.js', () => ({
  touchEnvironmentTimestamp: mocks.touchEnvironmentTimestamp,
}));
vi.mock('./repo-storage.js', () => ({
  getManifestJson: mocks.getManifestJson,
  copyBlobSameRegion: mocks.copyBlobSameRegion,
  copyManifestSameRegion: mocks.copyManifestSameRegion,
  setLatest: mocks.setLatest,
}));

import { executePromote, type PromoteDeps } from './execute-promote.js';
import type { CloneJob } from './clone-jobs.js';

const job = {
  id: 'job_p1',
  mode: 'promote',
  source_app_id: 'app_staging',
  dest_app_id: 'app_prod',
  requested_by_user_id: 'user_1',
  // Pinned at request time by startPromote — see fix round 1 comment above.
  source_snapshot_id: 'snap_123',
} as unknown as CloneJob;

// runtimeDb doubles as the "apps" lookup pool: only used by the 'repo' step
// for the final UPDATE apps.repo_latest_snapshot on PRODUCTION now that the
// staging-HEAD read moved to request time (startPromote).
const runtimeQuery = vi.fn();

const deps: PromoteDeps = {
  controlDb: { tag: 'control', query: vi.fn().mockResolvedValue({ rows: [] }) } as never,
  runtimeDb: { tag: 'runtime', query: runtimeQuery } as never,
  stagingPool: { tag: 'staging' } as never,
  prodPool: { tag: 'prod' } as never,
  prodOwnerId: 'owner_prod',
  attempt: 3,
  maxAttempts: 3,
  logger: { info: () => {}, warn: () => {}, error: () => {} },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.setCloneJobStatus.mockResolvedValue(undefined);
  mocks.appendCloneJobWarnings.mockResolvedValue(undefined);
  mocks.touchEnvironmentTimestamp.mockResolvedValue(undefined);
  mocks.replaySchema.mockResolvedValue(undefined);
  mocks.replayRls.mockResolvedValue({ replayed: 0, warnings: [] });
  mocks.replayFunctions.mockResolvedValue({
    count: 0, warnings: [], unfilledEnvVars: {}, overrideFilledFunctions: {},
    disabledTriggersInserted: [],
  });
  mocks.replayNonSecretConfig.mockResolvedValue({ warnings: [] });
  mocks.replayDurableObjectsForClone.mockResolvedValue({
    cloned: [], do_env_keys: [], auto_minted_keys: [], override_filled_keys: [],
  });
  mocks.replayFrontend.mockResolvedValue({ warnings: [] });

  // Default: the manifest for job.source_snapshot_id has one file, and
  // production is on the default 'pages' deployment_backend.
  runtimeQuery.mockResolvedValue({ rows: [{ deployment_backend: 'pages' }] });
  mocks.getManifestJson.mockResolvedValue(
    JSON.stringify({ files: [{ path: 'index.html', sha256: 'abc', size: 1 }] }),
  );
  mocks.copyBlobSameRegion.mockResolvedValue(undefined);
  mocks.copyManifestSameRegion.mockResolvedValue(undefined);
  mocks.setLatest.mockResolvedValue(undefined);
});

describe('promote publishes the repo snapshot', () => {
  it('uses job.source_snapshot_id (pinned at request time), not a live re-read of staging', async () => {
    await executePromote(deps, job);
    expect(mocks.getManifestJson).toHaveBeenCalledWith('app_staging', 'snap_123');
    // No SELECT against apps.repo_latest_snapshot for the STAGING app — the
    // value came from the job row, fixed by startPromote at request time.
    // (A separate SELECT against apps.deployment_backend for PRODUCTION now
    // happens in the frontend step — see the 'promote deploys the frontend'
    // describe block below — which is unrelated to this assertion.)
    const stagingRepoRead = runtimeQuery.mock.calls.find(
      (c) =>
        typeof c[0] === 'string' &&
        /SELECT/i.test(c[0]) &&
        /repo_latest_snapshot/.test(c[0]) &&
        Array.isArray(c[1]) &&
        c[1][0] === 'app_staging',
    );
    expect(stagingRepoRead).toBeUndefined();
  });

  it('copies every distinct blob and the manifest onto production, then advances latest', async () => {
    await executePromote(deps, job);
    expect(mocks.copyBlobSameRegion).toHaveBeenCalledWith('app_staging', 'app_prod', 'abc');
    expect(mocks.copyManifestSameRegion).toHaveBeenCalledWith('app_staging', 'app_prod', 'snap_123');
    expect(mocks.setLatest).toHaveBeenCalledWith('app_prod', 'snap_123');
  });

  it('writes apps.repo_latest_snapshot for production to the new snapshot', async () => {
    await executePromote(deps, job);
    const updateCall = runtimeQuery.mock.calls.find(
      (c) => typeof c[0] === 'string' && /UPDATE apps/.test(c[0]) && /repo_latest_snapshot/.test(c[0]),
    );
    expect(updateCall).toBeDefined();
    expect(updateCall![1]).toEqual(['snap_123', 'app_prod']);
  });

  // End-to-end coverage of the chosen NULL behaviour: a promote whose staging
  // app had no repo at request time is a legitimate backend-only promote, not
  // a refusal. Pinned here so nobody "fixes" it back into a hard failure.
  describe('when staging had no repo snapshot at request time (job.source_snapshot_id is null)', () => {
    const jobNoRepo = { ...job, source_snapshot_id: null } as unknown as CloneJob;

    it('completes the promote without touching repo storage', async () => {
      await expect(executePromote(deps, jobNoRepo)).resolves.toBeUndefined();
      expect(mocks.getManifestJson).not.toHaveBeenCalled();
      expect(mocks.copyBlobSameRegion).not.toHaveBeenCalled();
      expect(mocks.copyManifestSameRegion).not.toHaveBeenCalled();
      expect(mocks.setLatest).not.toHaveBeenCalled();
      expect(mocks.setCloneJobStatus).toHaveBeenLastCalledWith(
        deps.controlDb, 'job_p1', expect.objectContaining({ status: 'completed' }),
      );
    });

    it('still redeploys the frontend independently (repo and frontend artifacts are unrelated)', async () => {
      await executePromote(deps, jobNoRepo);
      expect(mocks.replayFrontend).toHaveBeenCalled();
    });

    it('warns the user that nothing was published, without failing the job', async () => {
      await executePromote(deps, jobNoRepo);
      const surfaced = mocks.appendCloneJobWarnings.mock.calls.map((c) => c[2]).flat();
      const notice = surfaced.find((w: string) => /no repo snapshot/i.test(w));
      expect(notice).toBeDefined();
      expect(notice).toMatch(/Schema, RLS.*functions and config were still promoted/);
    });
  });
});

describe('promote deploys the frontend', () => {
  it('deploys the production frontend after the replay steps, with failures set to throw', async () => {
    await executePromote(deps, job);
    expect(mocks.replayFrontend).toHaveBeenCalledWith(
      deps.controlDb, deps.runtimeDb, 'app_staging', 'app_prod', 'user_1',
      expect.anything(),
      expect.objectContaining({ throwOnFailure: true }),
    );
  });

  it('fails the job when the deploy fails, so the user is not told it went live', async () => {
    mocks.replayFrontend.mockRejectedValueOnce(new Error('cf error'));
    await expect(executePromote(deps, job)).rejects.toThrow('cf error');
    expect(mocks.setCloneJobStatus).toHaveBeenLastCalledWith(
      deps.controlDb, 'job_p1', expect.objectContaining({ status: 'failed' }),
    );
    // toHaveBeenLastCalledWith alone would still pass a buggy implementation
    // that wrote 'completed' and THEN 'failed' — assert 'completed' was never
    // written at all, not just that it isn't the last call.
    expect(mocks.setCloneJobStatus).not.toHaveBeenCalledWith(
      expect.anything(), 'job_p1', expect.objectContaining({ status: 'completed' }),
    );
  });

  it('does not mark the promote complete before the deploy resolves', async () => {
    const order: string[] = [];
    mocks.replayFrontend.mockImplementation(async () => {
      order.push('deploy');
      return { warnings: [] };
    });
    mocks.setCloneJobStatus.mockImplementation(async (_d: unknown, _j: unknown, s: { status?: string }) => {
      if (s.status === 'completed') order.push('completed');
    });
    await executePromote(deps, job);
    expect(order).toEqual(['deploy', 'completed']);
  });

  it('passes warnOnZeroRewrite so a stale-app-id bundle surfaces on the job, not just in logs', async () => {
    await executePromote(deps, job);
    expect(mocks.replayFrontend).toHaveBeenCalledWith(
      deps.controlDb, deps.runtimeDb, 'app_staging', 'app_prod', 'user_1',
      expect.anything(),
      expect.objectContaining({ warnOnZeroRewrite: true }),
    );
  });

  // Fix round 2 (I2): 'completed' does not mean live for the default backend
  // — deployViaPages returns BUILDING and the actual build happens
  // asynchronously on Cloudflare's side. Read deployment_backend and disclose
  // that rather than overstating what the job guarantees.
  describe('deployment_backend disclosure', () => {
    it('warns that the deploy is still building for the default pages backend', async () => {
      runtimeQuery.mockResolvedValue({ rows: [{ deployment_backend: 'pages' }] });
      await executePromote(deps, job);
      const surfaced = mocks.appendCloneJobWarnings.mock.calls.map((c) => c[2]).flat();
      const notice = surfaced.find((w: string) => /still building/i.test(w));
      expect(notice).toBeDefined();
      expect(notice).toMatch(/does NOT yet mean the new bundle is live/);
    });

    it('also warns when deployment_backend is missing/unrecognized (defaults to pages)', async () => {
      runtimeQuery.mockResolvedValue({ rows: [{ deployment_backend: null }] });
      await executePromote(deps, job);
      const surfaced = mocks.appendCloneJobWarnings.mock.calls.map((c) => c[2]).flat();
      expect(surfaced.some((w: string) => /still building/i.test(w))).toBe(true);
    });

    it('does not warn for the wfp backend, which deploys synchronously to a terminal state', async () => {
      runtimeQuery.mockResolvedValue({ rows: [{ deployment_backend: 'wfp' }] });
      await executePromote(deps, job);
      const surfaced = mocks.appendCloneJobWarnings.mock.calls.map((c) => c[2]).flat();
      expect(surfaced.some((w: string) => /still building/i.test(w))).toBe(false);
    });
  });
});
