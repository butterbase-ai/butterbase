/**
 * executeStagingReset re-seeds a staging app from PRODUCTION — the one job in
 * this feature whose direction is reversed from every other (promote, update,
 * clone all flow staging -> production; reset flows production -> staging).
 *
 * Two independent hazards, both destructive and unrecoverable, are tested
 * here:
 *   - replaySeedData's pool argument order (an insert-direction hazard: swap
 *     it and staging's stale rows overwrite production's).
 *   - the TRUNCATE this file adds (fix round 1): a truncate aimed at the
 *     source pool would destroy a customer's live production data. The
 *     'truncates ONLY the staging pool, never production' test below is the
 *     one that matters most in this file.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getEnvironmentLink: vi.fn(),
  touchEnvironmentTimestamp: vi.fn(),
  replaySeedData: vi.fn(),
  getSeedTableNames: vi.fn(),
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
vi.mock('./clone-replay.js', () => ({
  replaySeedData: mocks.replaySeedData,
  getSeedTableNames: mocks.getSeedTableNames,
}));
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

function makePool() {
  return { query: vi.fn().mockResolvedValue({ rows: [] }) };
}

let prodPool: ReturnType<typeof makePool>;
let stagingPool: ReturnType<typeof makePool>;
let deps: {
  controlDb: never; runtimeDb: never;
  prodPool: never; stagingPool: never;
  attempt: number; maxAttempts: number;
  logger: { info: () => void; warn: () => void; error: () => void };
};

beforeEach(() => {
  vi.clearAllMocks();
  prodPool = makePool();
  stagingPool = makePool();
  deps = {
    controlDb: {} as never,
    runtimeDb: {} as never,
    prodPool: prodPool as never,
    stagingPool: stagingPool as never,
    // Single-attempt by default: most tests want a thrown error to go
    // terminal immediately. The attempt-gating tests below override these.
    attempt: 1,
    maxAttempts: 1,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };
  mocks.getRuntimeDbForApp.mockResolvedValue({
    query: vi.fn().mockResolvedValue({ rows: [{ region: 'us-east-1' }] }),
  });
  mocks.getEnvironmentLink.mockResolvedValue({ staging_app_id: 'app_staging' });
  mocks.createCloneJob.mockResolvedValue({ id: 'job_r1' });
  mocks.setCloneJobStatus.mockResolvedValue(undefined);
  mocks.replaySeedData.mockResolvedValue(undefined);
  mocks.getSeedTableNames.mockResolvedValue(['widgets', 'orders']);
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
    await executeStagingReset(deps as never, job);
    expect(mocks.replaySeedData).toHaveBeenCalledWith(
      deps.prodPool, deps.stagingPool, expect.anything(),
    );
  });

  it('fails loudly if the pools were swapped (direction regression guard)', async () => {
    // Sanity check on the test's own fixtures: prodPool and stagingPool must
    // be distinguishable objects, or the assertion above could pass by
    // accident even with the arguments reversed.
    expect(deps.prodPool).not.toBe(deps.stagingPool);
    await executeStagingReset(deps as never, job);
    const call = mocks.replaySeedData.mock.calls[0];
    expect(call[0]).toBe(prodPool);
    expect(call[1]).toBe(stagingPool);
    // A reversed call would have call[0] === stagingPool — assert the
    // negative explicitly so a future edit that swaps the arguments fails
    // this test even if someone loosens the assertion above.
    expect(call[0]).not.toBe(stagingPool);
    expect(call[1]).not.toBe(prodPool);
  });

  // The test that matters most in this file (fix round 1): a TRUNCATE aimed
  // at the wrong pool destroys a customer's live production data,
  // unrecoverably. This fails if a future edit ever routes the truncate at
  // prodPool instead of stagingPool.
  it('truncates ONLY the staging pool before re-seeding, never production', async () => {
    await executeStagingReset(deps as never, job);

    const truncateCalls = stagingPool.query.mock.calls.filter(
      (c) => typeof c[0] === 'string' && /^TRUNCATE TABLE/i.test(c[0]),
    );
    expect(truncateCalls).toHaveLength(1);
    expect(truncateCalls[0][0]).toContain('"widgets"');
    expect(truncateCalls[0][0]).toContain('"orders"');

    // prodPool.query must never be called at all by executeStagingReset —
    // not for the truncate, not for its cascade-closure introspection.
    // replaySeedData (mocked) is the only thing that would ever legitimately
    // touch prodPool, and it never calls back into deps.prodPool.query here.
    expect(prodPool.query).not.toHaveBeenCalled();
  });

  it('derives the truncated table set via getSeedTableNames, not a hardcoded list', async () => {
    mocks.getSeedTableNames.mockResolvedValue(['custom_seed_table']);
    await executeStagingReset(deps as never, job);
    expect(mocks.getSeedTableNames).toHaveBeenCalledWith(deps.stagingPool, expect.anything());
    const truncateCalls = stagingPool.query.mock.calls.filter(
      (c) => typeof c[0] === 'string' && /^TRUNCATE TABLE/i.test(c[0]),
    );
    expect(truncateCalls[0][0]).toContain('"custom_seed_table"');
  });

  it('skips the truncate entirely when there are no seed-flagged tables', async () => {
    mocks.getSeedTableNames.mockResolvedValue([]);
    await executeStagingReset(deps as never, job);
    const truncateCalls = stagingPool.query.mock.calls.filter(
      (c) => typeof c[0] === 'string' && /^TRUNCATE TABLE/i.test(c[0]),
    );
    expect(truncateCalls).toHaveLength(0);
    expect(mocks.replaySeedData).toHaveBeenCalled();
  });

  it('hard-refuses before touching anything when dest_app_id equals the production app id', async () => {
    const malformedJob = {
      ...job, source_app_id: 'app_x', dest_app_id: 'app_x',
    } as never;
    await expect(executeStagingReset(deps as never, malformedJob)).rejects.toThrow(
      /refusing to reset/i,
    );
    expect(prodPool.query).not.toHaveBeenCalled();
    expect(stagingPool.query).not.toHaveBeenCalled();
    expect(mocks.replaySeedData).not.toHaveBeenCalled();
    expect(mocks.setCloneJobStatus).toHaveBeenCalledWith(
      deps.controlDb, 'job_r1', expect.objectContaining({ status: 'failed' }),
    );
  });

  it('refuses when the staging pool is reference-identical to the production pool', async () => {
    const samePool = makePool();
    const badDeps = { ...deps, prodPool: samePool as never, stagingPool: samePool as never };
    await expect(executeStagingReset(badDeps as never, job)).rejects.toThrow(
      /reference-identical/i,
    );
    expect(mocks.replaySeedData).not.toHaveBeenCalled();
  });

  it('re-applies isolation after truncate + re-seed, in real sequence', async () => {
    const order: string[] = [];
    stagingPool.query.mockImplementation(async (sql: unknown) => {
      if (typeof sql === 'string' && /^TRUNCATE TABLE/i.test(sql)) order.push('truncate');
      return { rows: [] };
    });
    mocks.replaySeedData.mockImplementation(async () => { order.push('seed'); });
    mocks.isolateStagingApp.mockImplementation(async () => { order.push('isolate'); });
    mocks.isolateStagingMeetingsWebhook.mockImplementation(async () => { order.push('isolate-webhook'); });
    await executeStagingReset(deps as never, job);
    expect(order).toEqual(['truncate', 'seed', 'isolate', 'isolate-webhook']);
  });

  it('isolates the STAGING app id, not production', async () => {
    await executeStagingReset(deps as never, job);
    expect(mocks.isolateStagingApp).toHaveBeenCalledWith(deps.runtimeDb, 'app_staging');
    expect(mocks.isolateStagingMeetingsWebhook).toHaveBeenCalledWith(deps.controlDb, 'app_staging');
  });

  it('records the reset time keyed on the PRODUCTION app id', async () => {
    await executeStagingReset(deps as never, job);
    expect(mocks.touchEnvironmentTimestamp)
      .toHaveBeenCalledWith(deps.runtimeDb, 'app_prod', 'last_reset_at');
  });

  it('fails the job when seeding throws on the final attempt', async () => {
    mocks.replaySeedData.mockRejectedValueOnce(new Error('seed boom'));
    await expect(executeStagingReset(deps as never, job)).rejects.toThrow('seed boom');
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
    await expect(executeStagingReset(retryDeps as never, job)).rejects.toThrow('transient boom');
    const statusCalls = mocks.setCloneJobStatus.mock.calls;
    const lastCall = statusCalls[statusCalls.length - 1];
    expect(lastCall[2]).not.toMatchObject({ status: 'failed' });
  });

  it('marks the job failed once the final attempt is exhausted', async () => {
    mocks.replaySeedData.mockRejectedValueOnce(new Error('final boom'));
    const finalDeps = { ...deps, attempt: 3, maxAttempts: 3 };
    await expect(executeStagingReset(finalDeps as never, job)).rejects.toThrow('final boom');
    expect(mocks.setCloneJobStatus).toHaveBeenLastCalledWith(
      deps.controlDb, 'job_r1', expect.objectContaining({ status: 'failed' }),
    );
  });
});
