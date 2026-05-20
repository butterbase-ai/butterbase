import { describe, it, expect, vi } from 'vitest';
import { executeDumpData } from './step-dump-data.js';

describe('executeDumpData', () => {
  it('returns dump_object_key and advances to restoring_data', async () => {
    const ctx: any = {
      controlPool: { query: vi.fn() },
      runtimePoolFor: vi.fn(),
      redisFor: vi.fn(),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      uploadDump: vi.fn().mockResolvedValue({ key: 'move-app/mig-1/dump.sql.gz', bytes: 12345 }),
      readSourceConnectionUri: vi.fn().mockResolvedValue('postgresql://source/db'),
    };
    const m: any = {
      id: 'mig-1', app_id: 'app-x', user_id: 'u', source_region: 'us-east-1',
      dest_region: 'eu-west-1', current_step: 'dumping_data', dest_resources: {},
    };
    const res = await executeDumpData(ctx, m);
    expect(res.next).toBe('restoring_data');
    expect(res.patch).toMatchObject({ dump_object_key: 'move-app/mig-1/dump.sql.gz' });
  });

  it('is idempotent — skips when dump_object_key already set', async () => {
    const ctx: any = {
      uploadDump: vi.fn(),
      readSourceConnectionUri: vi.fn(),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      runtimePoolFor: vi.fn(),
      controlPool: { query: vi.fn() },
      redisFor: vi.fn(),
    };
    const m: any = {
      id: 'mig-1', app_id: 'app-x', source_region: 'us-east-1', dest_region: 'eu-west-1',
      current_step: 'dumping_data', dest_resources: { dump_object_key: 'already' },
    };
    const res = await executeDumpData(ctx, m);
    expect(ctx.uploadDump).not.toHaveBeenCalled();
    expect(res.next).toBe('restoring_data');
  });
});
