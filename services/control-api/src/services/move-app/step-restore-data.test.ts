import { describe, it, expect, vi } from 'vitest';
import { executeRestoreData } from './step-restore-data.js';

describe('executeRestoreData', () => {
  it('streams dump → psql, advances to copying_blobs', async () => {
    const ctx: any = {
      controlPool: { query: vi.fn() }, runtimePoolFor: vi.fn(), redisFor: vi.fn(),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      downloadDump: vi.fn().mockResolvedValue({ stream: 'fakeStream' }),
      readDestConnectionUri: vi.fn().mockResolvedValue('postgresql://dest'),
      runPsql: vi.fn().mockResolvedValue({ rowsApplied: 0 }),
    };
    const m: any = {
      id: 'mig-1', app_id: 'app-x', source_region: 'us-east-1', dest_region: 'eu-west-1',
      current_step: 'restoring_data',
      dest_resources: { dump_object_key: 'move-app/mig-1/dump.sql.gz' },
    };
    const res = await executeRestoreData(ctx, m);
    expect(res.next).toBe('dumping_kv');
    expect(ctx.runPsql).toHaveBeenCalledOnce();
  });

  it('is idempotent', async () => {
    const ctx: any = {
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      downloadDump: vi.fn(), readDestConnectionUri: vi.fn(), runPsql: vi.fn(),
      controlPool: { query: vi.fn() }, runtimePoolFor: vi.fn(), redisFor: vi.fn(),
    };
    const m: any = {
      id: 'mig-1', app_id: 'app-x', source_region: 'us-east-1', dest_region: 'eu-west-1',
      current_step: 'restoring_data',
      dest_resources: { dump_object_key: 'x', restore_completed_at: '2026-01-01T00:00:00Z' },
    };
    const res = await executeRestoreData(ctx, m);
    expect(ctx.runPsql).not.toHaveBeenCalled();
    expect(res.next).toBe('dumping_kv');
  });
});
