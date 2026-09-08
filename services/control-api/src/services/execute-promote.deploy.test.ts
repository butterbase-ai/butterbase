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
} as unknown as CloneJob;

// runtimeDb doubles as the "apps" lookup pool for the repo step (staging is
// pinned to production's region, so one pool serves both sides).
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

  // Default: staging has a repo snapshot, and its manifest has one file.
  runtimeQuery.mockResolvedValue({ rows: [{ repo_latest_snapshot: 'snap_123' }] });
  mocks.getManifestJson.mockResolvedValue(
    JSON.stringify({ files: [{ path: 'index.html', sha256: 'abc', size: 1 }] }),
  );
  mocks.copyBlobSameRegion.mockResolvedValue(undefined);
  mocks.copyManifestSameRegion.mockResolvedValue(undefined);
  mocks.setLatest.mockResolvedValue(undefined);
});

describe('promote publishes the repo snapshot', () => {
  it('reads the STAGING app repo_latest_snapshot at execution time, not job.source_snapshot_id', async () => {
    await executePromote(deps, job);
    expect(runtimeQuery).toHaveBeenCalledWith(
      expect.stringContaining('repo_latest_snapshot'),
      ['app_staging'],
    );
  });

  it('copies every distinct blob and the manifest onto production, then advances latest', async () => {
    await executePromote(deps, job);
    expect(mocks.getManifestJson).toHaveBeenCalledWith('app_staging', 'snap_123');
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

  it('skips the repo publish (no throw) when staging has never pushed a repo snapshot', async () => {
    runtimeQuery.mockResolvedValue({ rows: [{ repo_latest_snapshot: null }] });
    await expect(executePromote(deps, job)).resolves.toBeUndefined();
    expect(mocks.getManifestJson).not.toHaveBeenCalled();
    expect(mocks.copyBlobSameRegion).not.toHaveBeenCalled();
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
});
