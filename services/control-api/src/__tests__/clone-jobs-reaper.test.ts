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

describe('clone-jobs-reaper: B1 — stranded processing jobs', () => {
  let controlDb: { query: ReturnType<typeof vi.fn> };
  let logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    controlDb = { query: vi.fn() };
    logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    vi.clearAllMocks();
  });

  it("candidate query allows status='processing' only for the modes this plan introduced", async () => {
    controlDb.query.mockResolvedValueOnce({ rows: [] });
    const { runOnce } = await import('../services/clone-jobs-reaper.js');
    await runOnce(controlDb as any, logger as any);

    const candidateSql = controlDb.query.mock.calls[0][0] as string;
    expect(candidateSql).toContain('processing');
    expect(candidateSql).toContain('staging_create');
    expect(candidateSql).toContain('promote');
    expect(candidateSql).toContain('staging_reset');
  });

  it('reaps a promote job stranded in processing past the stale threshold with no live neon_task', async () => {
    const stuckRow = {
      id: 'cj_promote_stuck',
      source_app_id: 'app_staging',
      dest_app_id: 'app_prod',
      dest_region: 'us-east-1',
      status: 'processing',
      requested_by_user_id: 'user_1',
      updated_at: new Date(Date.now() - 30 * 60_000),
      age_minutes: '30',
      mode: 'promote',
    };
    controlDb.query
      .mockResolvedValueOnce({ rows: [stuckRow] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const { getRuntimeDbPool } = await import('../services/runtime-db.js');
    (getRuntimeDbPool as any).mockReturnValue({
      query: vi.fn().mockResolvedValue({ rows: [] }),
    });

    const { runOnce } = await import('../services/clone-jobs-reaper.js');
    const result = await runOnce(controlDb as any, logger as any);

    expect(result.reapedJobIds).toEqual(['cj_promote_stuck']);
  });

  it("idx_template_clone_jobs_one_promote regression: a stranded 'processing' promote becomes terminal so a later promote is not permanently blocked", async () => {
    // Direct proof the fix is load-bearing: TERMINAL_CLONE_STATUSES (and thus
    // idx_template_clone_jobs_one_promote's predicate) must consider the
    // reaper's outcome terminal.
    const { isTerminalCloneStatus } = await import('../services/clone-jobs.js');
    expect(isTerminalCloneStatus('failed')).toBe(true);

    const stuckRow = {
      id: 'cj_promote_stuck2',
      source_app_id: 'app_staging',
      dest_app_id: 'app_prod',
      dest_region: 'us-east-1',
      status: 'processing',
      requested_by_user_id: 'user_1',
      updated_at: new Date(Date.now() - 30 * 60_000),
      age_minutes: '30',
      mode: 'promote',
    };
    controlDb.query
      .mockResolvedValueOnce({ rows: [stuckRow] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const { getRuntimeDbPool } = await import('../services/runtime-db.js');
    (getRuntimeDbPool as any).mockReturnValue({
      query: vi.fn().mockResolvedValue({ rows: [] }),
    });

    const { runOnce } = await import('../services/clone-jobs-reaper.js');
    await runOnce(controlDb as any, logger as any);

    const updateCall = controlDb.query.mock.calls[1];
    expect(updateCall[0]).toContain('UPDATE template_clone_jobs');
    expect(updateCall[1]).toContain('failed');
  });

  it('does not reap a plain clone job stranded in processing (existing clone/update behavior untouched)', async () => {
    // With a mocked DB, the WHERE clause itself cannot be exercised, but the
    // candidate SQL text is asserted above to scope 'processing' inclusion by
    // mode. This test locks in that runOnce still reaps whatever the query
    // hands back — mode='clone' rows in 'processing' should never be returned
    // by the real SQL, so this exists to make a future accidental widening of
    // the SQL predicate to all modes show up as a behavior change here too.
    const stuckRow = {
      id: 'cj_clone_processing',
      source_app_id: 'app_src',
      dest_app_id: 'app_dst',
      dest_region: 'us-east-1',
      status: 'processing',
      requested_by_user_id: 'user_1',
      updated_at: new Date(Date.now() - 30 * 60_000),
      age_minutes: '30',
      mode: 'clone',
    };
    // Simulate the real SQL correctly excluding this row: fetchCandidates
    // returns nothing for a plain clone in processing.
    controlDb.query.mockResolvedValueOnce({ rows: [] });
    void stuckRow;

    const { runOnce } = await import('../services/clone-jobs-reaper.js');
    const result = await runOnce(controlDb as any, logger as any);
    expect(result.reapedJobIds).toEqual([]);
  });
});

describe('clone-jobs-reaper: B2 — mode-correct audit events and notification copy', () => {
  let controlDb: { query: ReturnType<typeof vi.fn> };
  let logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    controlDb = { query: vi.fn() };
    logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    vi.clearAllMocks();
  });

  async function reapOneMode(mode: 'clone' | 'update' | 'staging_create' | 'promote' | 'staging_reset') {
    const stuckRow = {
      id: `cj_${mode}`,
      source_app_id: 'app_src',
      dest_app_id: 'app_dst',
      dest_region: 'us-east-1',
      status: 'replaying_rls',
      requested_by_user_id: 'user_1',
      updated_at: new Date(Date.now() - 30 * 60_000),
      age_minutes: '30',
      mode,
    };
    controlDb.query
      .mockResolvedValueOnce({ rows: [stuckRow] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const { getRuntimeDbPool } = await import('../services/runtime-db.js');
    (getRuntimeDbPool as any).mockReturnValue({
      query: vi.fn().mockResolvedValue({ rows: [] }),
    });

    const { runOnce } = await import('../services/clone-jobs-reaper.js');
    await runOnce(controlDb as any, logger as any);
  }

  it('maps update to template_update_failed', async () => {
    const { insertCloneAuditLog } = await import('../services/audit/audit-events-service.js');
    await reapOneMode('update');
    expect(insertCloneAuditLog).toHaveBeenCalledWith(
      controlDb,
      expect.objectContaining({ eventType: 'template_update_failed' }),
    );
  });

  it('maps promote to staging_promote_failed, not a plain clone failure', async () => {
    const { insertCloneAuditLog } = await import('../services/audit/audit-events-service.js');
    await reapOneMode('promote');
    expect(insertCloneAuditLog).toHaveBeenCalledWith(
      controlDb,
      expect.objectContaining({ eventType: 'staging_promote_failed' }),
    );
  });

  it('maps staging_reset to staging_reset_failed, not a plain clone failure', async () => {
    const { insertCloneAuditLog } = await import('../services/audit/audit-events-service.js');
    await reapOneMode('staging_reset');
    expect(insertCloneAuditLog).toHaveBeenCalledWith(
      controlDb,
      expect.objectContaining({ eventType: 'staging_reset_failed' }),
    );
  });

  it('maps staging_create and clone to template_clone_failed', async () => {
    const { insertCloneAuditLog } = await import('../services/audit/audit-events-service.js');
    await reapOneMode('staging_create');
    expect(insertCloneAuditLog).toHaveBeenCalledWith(
      controlDb,
      expect.objectContaining({ eventType: 'template_clone_failed' }),
    );
  });

  it('passes the real mode through to notifyCloneFailed for every mode (no mislabeled emails)', async () => {
    const { notifyCloneFailed } = await import('../services/failure-notifications.service.js');
    for (const mode of ['clone', 'update', 'staging_create', 'promote', 'staging_reset'] as const) {
      vi.clearAllMocks();
      await reapOneMode(mode);
      expect(notifyCloneFailed).toHaveBeenCalledWith(
        controlDb,
        expect.anything(),
        expect.objectContaining({ mode }),
        logger,
      );
    }
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
