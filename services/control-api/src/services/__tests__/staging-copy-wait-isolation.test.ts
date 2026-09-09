/**
 * DEFECT 3 — a failed copy left production's connected-account row in staging.
 *
 * The copy engine's phases run in order and the `platform` phase, which
 * re-imports production's `app_connected_accounts` rows, completes before
 * `verify`. `isolateStagingEnvironment` — the pass that deletes them again —
 * lived ONLY on this task's success path, so a copy that failed at verify left
 * production's own connected-account record sitting inside the staging app.
 * The live smoke test found exactly that:
 *   `app_8fr1kwf63w8a | gmail | ca_prod_abc | expired`
 *
 * A staging app that failed to populate must still not hold production's
 * connections. The failure makes it more urgent, not less: a failed job is
 * precisely the state a user leaves sitting around while they work out what
 * went wrong.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  isolateStagingEnvironment: vi.fn(),
  linkStagingEnvironment: vi.fn(),
  finalizeStagingClone: vi.fn(),
  getStagingDataCopy: vi.fn(),
  appendCloneJobWarnings: vi.fn(),
  setCloneJobStatus: vi.fn(),
  getCloneJob: vi.fn(),
  touchEnvironmentTimestamp: vi.fn(),
  enqueueCopyWaitTask: vi.fn(),
}));

vi.mock('../staging-completion.js', () => ({
  isolateStagingEnvironment: mocks.isolateStagingEnvironment,
  linkStagingEnvironment: mocks.linkStagingEnvironment,
  finalizeStagingClone: mocks.finalizeStagingClone,
}));

vi.mock('../staging-data-copy.js', async (orig) => ({
  ...(await orig<typeof import('../staging-data-copy.js')>()),
  getStagingDataCopy: mocks.getStagingDataCopy,
  enqueueCopyWaitTask: mocks.enqueueCopyWaitTask,
}));

vi.mock('../clone-jobs.js', async (orig) => ({
  ...(await orig<typeof import('../clone-jobs.js')>()),
  getCloneJob: mocks.getCloneJob,
  setCloneJobStatus: mocks.setCloneJobStatus,
  appendCloneJobWarnings: mocks.appendCloneJobWarnings,
}));

vi.mock('../app-environments.js', async (orig) => ({
  ...(await orig<typeof import('../app-environments.js')>()),
  touchEnvironmentTimestamp: mocks.touchEnvironmentTimestamp,
}));

vi.mock('../runtime-db.js', () => ({
  getRuntimeDbPool: () => ({ query: vi.fn().mockResolvedValue({ rows: [] }) }),
}));

import { executeStagingCopyWaitTask } from '../neon-task-worker.js';

const controlDb = { query: vi.fn().mockResolvedValue({ rows: [] }) } as never;
const silentLogger = { info() {}, warn() {}, error() {} };

const task = {
  id: 1, app_id: 'app_staging', task_type: 'clone' as const, status: 'processing',
  attempts: 1, max_attempts: 3, last_error: null, locked_at: null,
  run_after: new Date(), created_at: new Date(),
  task_meta: { job_id: 'cj_reset_1' },
};

function resetJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cj_reset_1',
    mode: 'staging_reset',
    status: 'copying_data',
    source_app_id: 'app_prod',
    dest_app_id: 'app_staging',
    dest_region: 'us-east-1',
    data_copy_job_id: 'ac_1',
    requested_by_user_id: 'u1',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isolateStagingEnvironment.mockResolvedValue(undefined);
  mocks.appendCloneJobWarnings.mockResolvedValue(undefined);
  mocks.setCloneJobStatus.mockResolvedValue(undefined);
  mocks.touchEnvironmentTimestamp.mockResolvedValue(undefined);
  mocks.linkStagingEnvironment.mockResolvedValue(undefined);
  mocks.getCloneJob.mockResolvedValue(resetJob());
});

describe('executeStagingCopyWaitTask — isolation on the failure path', () => {
  it('isolates the staging app when the copy FAILED', async () => {
    // The exact live shape: the copy got as far as `verify` — so the platform
    // phase that re-imports production's connected accounts had already run —
    // and then failed.
    mocks.getStagingDataCopy.mockResolvedValue({
      id: 'ac_1', status: 'failed', phase: 'verify',
      error_message: '0 table(s) short, 3 row(s) failed',
      result: null, created_at: new Date(), started_at: new Date(),
    });

    await executeStagingCopyWaitTask(controlDb, task, silentLogger);

    expect(mocks.isolateStagingEnvironment).toHaveBeenCalledTimes(1);
    expect(mocks.isolateStagingEnvironment).toHaveBeenCalledWith(
      expect.anything(), controlDb, 'app_staging',
    );
    // Still terminal, still failed — isolation does not rescue the job.
    expect(mocks.setCloneJobStatus).toHaveBeenCalledWith(
      controlDb, 'cj_reset_1', expect.objectContaining({ status: 'failed' }),
    );
  });

  it('isolates the staging app when the copy was ABORTED', async () => {
    mocks.getStagingDataCopy.mockResolvedValue({
      id: 'ac_1', status: 'aborted', phase: 'platform',
      error_message: null, result: null,
      created_at: new Date(), started_at: new Date(),
    });
    await executeStagingCopyWaitTask(controlDb, task, silentLogger);
    expect(mocks.isolateStagingEnvironment).toHaveBeenCalledWith(
      expect.anything(), controlDb, 'app_staging',
    );
  });

  it('isolates a FAILED staging_create too, not only a reset', async () => {
    mocks.getCloneJob.mockResolvedValue(resetJob({ mode: 'staging_create' }));
    mocks.getStagingDataCopy.mockResolvedValue({
      id: 'ac_1', status: 'failed', phase: 'verify', error_message: 'boom',
      result: null, created_at: new Date(), started_at: new Date(),
    });
    await executeStagingCopyWaitTask(controlDb, task, silentLogger);
    expect(mocks.isolateStagingEnvironment).toHaveBeenCalledWith(
      expect.anything(), controlDb, 'app_staging',
    );
    // A failed create must NOT become a linked staging environment.
    expect(mocks.linkStagingEnvironment).not.toHaveBeenCalled();
  });

  it('still reaches a terminal status when isolation itself fails, and says so', async () => {
    // A job stuck in `copying_data` forever is worse than an isolation pass
    // that has to be re-run — but the user must be told staging may still hold
    // production's connections.
    mocks.isolateStagingEnvironment.mockRejectedValue(new Error('runtime db down'));
    mocks.getStagingDataCopy.mockResolvedValue({
      id: 'ac_1', status: 'failed', phase: 'verify', error_message: 'boom',
      result: null, created_at: new Date(), started_at: new Date(),
    });

    await executeStagingCopyWaitTask(controlDb, task, silentLogger);

    expect(mocks.setCloneJobStatus).toHaveBeenCalledWith(
      controlDb, 'cj_reset_1', expect.objectContaining({ status: 'failed' }),
    );
    const appended = mocks.appendCloneJobWarnings.mock.calls
      .flatMap((c) => (c[2] as string[]) ?? []);
    expect(appended.some((w) => /may still hold connected-account records/i.test(w))).toBe(true);
  });

  it('does not isolate while the copy is still running', async () => {
    mocks.getStagingDataCopy.mockResolvedValue({
      id: 'ac_1', status: 'processing', phase: 'data', error_message: null,
      result: null, created_at: new Date(), started_at: new Date(),
    });
    await executeStagingCopyWaitTask(controlDb, task, silentLogger);
    expect(mocks.isolateStagingEnvironment).not.toHaveBeenCalled();
    expect(mocks.enqueueCopyWaitTask).toHaveBeenCalled();
  });

  it('still isolates on the success path (unchanged)', async () => {
    mocks.getStagingDataCopy.mockResolvedValue({
      id: 'ac_1', status: 'completed', phase: 'verify', error_message: null,
      result: { reconnect: [] }, created_at: new Date(), started_at: new Date(),
    });
    await executeStagingCopyWaitTask(controlDb, task, silentLogger);
    expect(mocks.isolateStagingEnvironment).toHaveBeenCalledWith(
      expect.anything(), controlDb, 'app_staging',
    );
    expect(mocks.setCloneJobStatus).toHaveBeenCalledWith(
      controlDb, 'cj_reset_1', expect.objectContaining({ status: 'completed' }),
    );
  });
});
