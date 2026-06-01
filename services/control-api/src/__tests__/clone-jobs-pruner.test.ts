import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('clone-jobs-pruner: runOnce', () => {
  let querySpy: ReturnType<typeof vi.fn>;
  let controlDb: { query: typeof querySpy };
  let logger: { info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    querySpy = vi.fn();
    controlDb = { query: querySpy };
    logger = { info: vi.fn(), error: vi.fn() };
  });

  it('deletes completed rows older than 30 days and returns count', async () => {
    querySpy.mockResolvedValue({ rows: [], rowCount: 3 });
    const { runOnce } = await import('../services/clone-jobs-pruner.js');

    const deleted = await runOnce(controlDb as any, logger as any);

    expect(deleted).toBe(3);
    expect(querySpy).toHaveBeenCalledOnce();
    const [sql] = querySpy.mock.calls[0];
    expect(sql).toContain('DELETE FROM template_clone_jobs');
    expect(sql).toContain("status IN ('completed', 'failed')");
    expect(sql).toContain('30 days');
  });

  it('returns 0 when nothing to prune', async () => {
    querySpy.mockResolvedValue({ rows: [], rowCount: 0 });
    const { runOnce } = await import('../services/clone-jobs-pruner.js');
    const deleted = await runOnce(controlDb as any, logger as any);
    expect(deleted).toBe(0);
  });
});

describe('clone-jobs-pruner: startCloneJobsPruner / stop', () => {
  it('stop() resolves without hanging', async () => {
    const { startCloneJobsPruner } = await import('../services/clone-jobs-pruner.js');
    const controlDb = { query: vi.fn().mockResolvedValue({ rowCount: 0 }) };
    const logger = { info: vi.fn(), error: vi.fn() };

    const handle = startCloneJobsPruner(controlDb as any, logger as any, 50_000);
    await handle.stop();
  });
});
