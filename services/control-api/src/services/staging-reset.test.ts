/**
 * executeStagingReset re-seeds a staging app from PRODUCTION — the one job in
 * this feature whose direction is reversed from every other (promote, update,
 * clone all flow staging -> production; reset flows production -> staging).
 *
 * Getting the pool order backwards on the replaySeedData call would overwrite
 * a customer's production data with staging's — unrecoverable data loss — so
 * the tests here pin that direction explicitly, not just via the mock
 * assertion shape.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getEnvironmentLink: vi.fn(),
  touchEnvironmentTimestamp: vi.fn(),
  replaySeedData: vi.fn(),
  isolateStagingApp: vi.fn(),
  isolateStagingMeetingsWebhook: vi.fn(),
  setCloneJobStatus: vi.fn(),
  createCloneJob: vi.fn(),
  getRuntimeDbForApp: vi.fn(),
}));

vi.mock('./app-environments.js', () => ({
  getEnvironmentLink: mocks.getEnvironmentLink,
  touchEnvironmentTimestamp: mocks.touchEnvironmentTimestamp,
}));
vi.mock('./clone-replay.js', () => ({ replaySeedData: mocks.replaySeedData }));
vi.mock('./staging-isolation.js', () => ({
  isolateStagingApp: mocks.isolateStagingApp,
  isolateStagingMeetingsWebhook: mocks.isolateStagingMeetingsWebhook,
}));
vi.mock('./clone-jobs.js', () => ({
  setCloneJobStatus: mocks.setCloneJobStatus,
  createCloneJob: mocks.createCloneJob,
}));
vi.mock('./region-resolver.js', () => ({ getRuntimeDbForApp: mocks.getRuntimeDbForApp }));

import { startStagingReset, executeStagingReset } from './staging-reset.js';

// job.source_app_id is PRODUCTION, job.dest_app_id is STAGING — the opposite
// of a promote job (source = staging, dest = production). This is the single
// most dangerous line in this test file: swap these two values and every
// assertion below still typechecks while describing the wrong app.
const job = {
  id: 'job_r1', mode: 'staging_reset', source_app_id: 'app_prod', dest_app_id: 'app_staging',
} as never;

const prodPool = { marker: 'prod' } as never;
const stagingPool = { marker: 'staging' } as never;

const deps = {
  controlDb: {} as never,
  runtimeDb: {} as never,
  prodPool,
  stagingPool,
  // Single-attempt by default: most tests want a thrown error to go
  // terminal immediately. The attempt-gating tests below override these.
  attempt: 1,
  maxAttempts: 1,
  logger: { info: () => {}, warn: () => {}, error: () => {} },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getRuntimeDbForApp.mockResolvedValue({
    query: vi.fn().mockResolvedValue({ rows: [{ region: 'us-east-1' }] }),
  });
  mocks.getEnvironmentLink.mockResolvedValue({ staging_app_id: 'app_staging' });
  mocks.createCloneJob.mockResolvedValue({ id: 'job_r1' });
  mocks.setCloneJobStatus.mockResolvedValue(undefined);
  mocks.replaySeedData.mockResolvedValue(undefined);
  mocks.isolateStagingApp.mockResolvedValue(undefined);
  mocks.isolateStagingMeetingsWebhook.mockResolvedValue(undefined);
  mocks.touchEnvironmentTimestamp.mockResolvedValue(undefined);
});

describe('startStagingReset', () => {
  it('creates a reset job targeting the staging app', async () => {
    const controlDb = { query: vi.fn().mockResolvedValue({ rows: [] }) } as never;
    const res = await startStagingReset({
      controlDb, prodAppId: 'app_prod', userId: 'u1', orgId: 'org_1',
    });
    expect(res).toMatchObject({ ok: true, jobId: 'job_r1', stagingAppId: 'app_staging' });
  });

  it('refuses when there is no staging environment', async () => {
    mocks.getEnvironmentLink.mockResolvedValue(null);
    const res = await startStagingReset({
      controlDb: {} as never, prodAppId: 'app_prod', userId: 'u1', orgId: 'org_1',
    });
    expect(res).toMatchObject({ ok: false, code: 'NO_STAGING' });
  });

  it('creates the job with the PRODUCTION app as source, not staging', async () => {
    const controlDb = { query: vi.fn().mockResolvedValue({ rows: [] }) } as never;
    await startStagingReset({
      controlDb, prodAppId: 'app_prod', userId: 'u1', orgId: 'org_1',
    });
    expect(mocks.createCloneJob).toHaveBeenCalledWith(
      controlDb,
      expect.objectContaining({ sourceAppId: 'app_prod' }),
    );
  });
});

describe('executeStagingReset', () => {
  it('seeds staging from production, never the reverse', async () => {
    await executeStagingReset(deps, job);
    expect(mocks.replaySeedData).toHaveBeenCalledWith(
      deps.prodPool, deps.stagingPool, expect.anything(),
    );
  });

  it('fails loudly if the pools were swapped (direction regression guard)', async () => {
    // Sanity check on the test's own fixtures: prodPool and stagingPool must
    // be distinguishable objects, or the assertion above could pass by
    // accident even with the arguments reversed.
    expect(deps.prodPool).not.toBe(deps.stagingPool);
    await executeStagingReset(deps, job);
    const call = mocks.replaySeedData.mock.calls[0];
    expect(call[0]).toBe(prodPool);
    expect(call[1]).toBe(stagingPool);
    // A reversed call would have call[0] === stagingPool — assert the
    // negative explicitly so a future edit that swaps the arguments fails
    // this test even if someone loosens the assertion above.
    expect(call[0]).not.toBe(stagingPool);
    expect(call[1]).not.toBe(prodPool);
  });

  it('re-applies isolation after re-seeding, in real sequence', async () => {
    const order: string[] = [];
    mocks.replaySeedData.mockImplementation(async () => { order.push('seed'); });
    mocks.isolateStagingApp.mockImplementation(async () => { order.push('isolate'); });
    mocks.isolateStagingMeetingsWebhook.mockImplementation(async () => { order.push('isolate-webhook'); });
    await executeStagingReset(deps, job);
    expect(order).toEqual(['seed', 'isolate', 'isolate-webhook']);
  });

  it('isolates the STAGING app id, not production', async () => {
    await executeStagingReset(deps, job);
    expect(mocks.isolateStagingApp).toHaveBeenCalledWith(deps.runtimeDb, 'app_staging');
    expect(mocks.isolateStagingMeetingsWebhook).toHaveBeenCalledWith(deps.controlDb, 'app_staging');
  });

  it('records the reset time keyed on the PRODUCTION app id', async () => {
    await executeStagingReset(deps, job);
    expect(mocks.touchEnvironmentTimestamp)
      .toHaveBeenCalledWith(deps.runtimeDb, 'app_prod', 'last_reset_at');
  });

  it('fails the job when seeding throws on the final attempt', async () => {
    mocks.replaySeedData.mockRejectedValueOnce(new Error('seed boom'));
    await expect(executeStagingReset(deps, job)).rejects.toThrow('seed boom');
    expect(mocks.setCloneJobStatus).toHaveBeenLastCalledWith(
      deps.controlDb, 'job_r1', expect.objectContaining({ status: 'failed' }),
    );
  });

  it('does NOT mark the job failed when attempts remain (matches executePromote/executeUpdate)', async () => {
    // Marking 'failed' on attempt 1 of 3 would make the two retries the
    // queue still owes silent no-ops — 'failed'/'completed' are the terminal
    // statuses a re-entry guard short-circuits on.
    mocks.replaySeedData.mockRejectedValueOnce(new Error('transient boom'));
    const retryDeps = { ...deps, attempt: 1, maxAttempts: 3 };
    await expect(executeStagingReset(retryDeps, job)).rejects.toThrow('transient boom');
    const statusCalls = mocks.setCloneJobStatus.mock.calls;
    const lastCall = statusCalls[statusCalls.length - 1];
    expect(lastCall[2]).not.toMatchObject({ status: 'failed' });
  });

  it('marks the job failed once the final attempt is exhausted', async () => {
    mocks.replaySeedData.mockRejectedValueOnce(new Error('final boom'));
    const finalDeps = { ...deps, attempt: 3, maxAttempts: 3 };
    await expect(executeStagingReset(finalDeps, job)).rejects.toThrow('final boom');
    expect(mocks.setCloneJobStatus).toHaveBeenLastCalledWith(
      deps.controlDb, 'job_r1', expect.objectContaining({ status: 'failed' }),
    );
  });
});
