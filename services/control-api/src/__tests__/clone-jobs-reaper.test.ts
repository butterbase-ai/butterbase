import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/runtime-db.js', () => ({
  getRuntimeDbPool: vi.fn(() => ({ query: vi.fn().mockResolvedValue({ rows: [] }) })),
}));

vi.mock('../services/failure-notifications.service.js', () => ({
  notifyCloneFailed: vi.fn().mockResolvedValue(undefined),
  notifyCloneReaperDigest: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/audit/audit-events-service.js', () => ({
  insertCloneAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../config.js', () => ({
  config: { runtimeDb: {} },
}));

describe('clone-jobs-reaper: guard behavior', () => {
  it('isTerminalCloneStatus correctly identifies terminal vs resumable statuses', async () => {
    const { isTerminalCloneStatus } = await import('../services/clone-jobs.js');
    expect(isTerminalCloneStatus('completed')).toBe(true);
    expect(isTerminalCloneStatus('failed')).toBe(true);
    expect(isTerminalCloneStatus('pending')).toBe(false);
    expect(isTerminalCloneStatus('processing')).toBe(false);
    expect(isTerminalCloneStatus('replaying_schema')).toBe(false);
    expect(isTerminalCloneStatus('replaying_rls')).toBe(false);
    expect(isTerminalCloneStatus('seeding_data')).toBe(false);
    expect(isTerminalCloneStatus('replaying_functions')).toBe(false);
    expect(isTerminalCloneStatus('replaying_config')).toBe(false);
    expect(isTerminalCloneStatus('copying_repo')).toBe(false);
  });
});

describe('clone-jobs-reaper: runOnce', () => {
  let controlDb: { query: ReturnType<typeof vi.fn> };
  let logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    controlDb = { query: vi.fn() };
    logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    vi.clearAllMocks();
  });

  it('reaps stuck jobs older than 15 minutes and returns their ids', async () => {
    const stuckRow = {
      id: 'cj_stuck',
      source_app_id: 'app_src',
      dest_app_id: 'app_dst',
      dest_region: 'us-east-1',
      status: 'replaying_rls',
      requested_by_user_id: 'user_1',
      updated_at: new Date(Date.now() - 30 * 60_000),
      age_minutes: '30',
    };
    // First call: fetchCandidates. Second call: setCloneJobStatus.
    controlDb.query
      .mockResolvedValueOnce({ rows: [stuckRow] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const { getRuntimeDbPool } = await import('../services/runtime-db.js');
    // No live neon_task for this job
    (getRuntimeDbPool as any).mockReturnValue({
      query: vi.fn().mockResolvedValue({ rows: [] }),
    });

    const { runOnce } = await import('../services/clone-jobs-reaper.js');
    const result = await runOnce(controlDb as any, logger as any);

    expect(result.reapedJobIds).toEqual(['cj_stuck']);
    expect(result.details[0]).toMatchObject({
      jobId: 'cj_stuck',
      destAppId: 'app_dst',
      stalledStage: 'replaying_rls',
      ageMinutes: 30,
    });

    // The setCloneJobStatus call — check we asked for status='failed'
    const updateCall = controlDb.query.mock.calls[1];
    expect(updateCall[0]).toContain('UPDATE template_clone_jobs');
    expect(updateCall[1]).toContain('failed');
  });

  it('leaves a stuck job alone when a live neon_task exists in its region', async () => {
    const stuckRow = {
      id: 'cj_still_running',
      source_app_id: 'app_src',
      dest_app_id: 'app_dst',
      dest_region: 'us-east-1',
      status: 'replaying_schema',
      requested_by_user_id: 'user_1',
      updated_at: new Date(Date.now() - 20 * 60_000),
      age_minutes: '20',
    };
    controlDb.query.mockResolvedValueOnce({ rows: [stuckRow] });

    const { getRuntimeDbPool } = await import('../services/runtime-db.js');
    (getRuntimeDbPool as any).mockReturnValue({
      query: vi.fn().mockResolvedValue({ rows: [{ id: 42 }] }),
    });

    const { runOnce } = await import('../services/clone-jobs-reaper.js');
    const result = await runOnce(controlDb as any, logger as any);

    expect(result.reapedJobIds).toEqual([]);
    // fetchCandidates only, no UPDATE
    expect(controlDb.query).toHaveBeenCalledOnce();
  });

  it('sends the digest email exactly once when at least one job was reaped', async () => {
    controlDb.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'cj_a',
          source_app_id: 'app_src',
          dest_app_id: 'app_dst',
          dest_region: 'us-east-1',
          status: 'replaying_rls',
          requested_by_user_id: 'user_1',
          updated_at: new Date(Date.now() - 30 * 60_000),
          age_minutes: '30',
        }],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const { getRuntimeDbPool } = await import('../services/runtime-db.js');
    (getRuntimeDbPool as any).mockReturnValue({
      query: vi.fn().mockResolvedValue({ rows: [] }),
    });

    const { notifyCloneReaperDigest } = await import('../services/failure-notifications.service.js');
    const { runOnce } = await import('../services/clone-jobs-reaper.js');
    await runOnce(controlDb as any, logger as any);
    expect(notifyCloneReaperDigest).toHaveBeenCalledOnce();
  });

  it('does not send the digest email when nothing was reaped', async () => {
    controlDb.query.mockResolvedValueOnce({ rows: [] });
    const { notifyCloneReaperDigest } = await import('../services/failure-notifications.service.js');
    const { runOnce } = await import('../services/clone-jobs-reaper.js');
    await runOnce(controlDb as any, logger as any);
    expect(notifyCloneReaperDigest).not.toHaveBeenCalled();
  });

  it('assumes live (skips reap) when the runtime lookup errors', async () => {
    controlDb.query.mockResolvedValueOnce({
      rows: [{
        id: 'cj_lookup_fail',
        source_app_id: 'app_src',
        dest_app_id: 'app_dst',
        dest_region: 'us-east-1',
        status: 'replaying_rls',
        requested_by_user_id: 'user_1',
        updated_at: new Date(Date.now() - 30 * 60_000),
        age_minutes: '30',
      }],
    });

    const { getRuntimeDbPool } = await import('../services/runtime-db.js');
    (getRuntimeDbPool as any).mockReturnValue({
      query: vi.fn().mockRejectedValue(new Error('region unreachable')),
    });

    const { runOnce } = await import('../services/clone-jobs-reaper.js');
    const result = await runOnce(controlDb as any, logger as any);
    expect(result.reapedJobIds).toEqual([]);
  });
});

describe('clone-jobs-reaper: startCloneJobsReaper / stop', () => {
  it('stop() resolves without hanging', async () => {
    const { startCloneJobsReaper } = await import('../services/clone-jobs-reaper.js');
    const controlDb = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const handle = startCloneJobsReaper(controlDb as any, logger as any, 50_000);
    await handle.stop();
  });
});
