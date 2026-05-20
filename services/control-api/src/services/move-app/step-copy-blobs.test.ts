import { describe, it, expect, vi } from 'vitest';
import { executeCopyBlobs } from './step-copy-blobs.js';

describe('executeCopyBlobs', () => {
  it('returns next=copying_runtime when STORAGE_PROVIDER=r2', async () => {
    process.env.STORAGE_PROVIDER = 'r2';
    const ctx: any = { controlPool: { query: vi.fn() }, runtimePoolFor: vi.fn(), redisFor: vi.fn(), log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } };
    const m: any = { id: 'mig-1', app_id: 'a', source_region: 'us-east-1', dest_region: 'eu-west-1', current_step: 'copying_blobs', dest_resources: {} };
    const r = await executeCopyBlobs(ctx, m);
    expect(r).toEqual({ next: 'copying_runtime', patch: { blobs_skipped: true } });
  });

  it('iterates storage_objects and copies for STORAGE_PROVIDER=s3', async () => {
    process.env.STORAGE_PROVIDER = 's3';
    const runtimePool = { query: vi.fn().mockResolvedValue({ rows: [{ object_key: 'k1' }, { object_key: 'k2' }] }) };
    const copyObject = vi.fn().mockResolvedValue(undefined);
    const ctx: any = {
      controlPool: { query: vi.fn() },
      runtimePoolFor: (_r: string) => runtimePool,
      redisFor: vi.fn(),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      copyObject,
    };
    const m: any = { id: 'mig-1', app_id: 'a', source_region: 'us-east-1', dest_region: 'eu-west-1', current_step: 'copying_blobs', dest_resources: {} };
    const res = await executeCopyBlobs(ctx, m);
    expect(copyObject).toHaveBeenCalledTimes(2);
    expect(res.next).toBe('copying_runtime');
  });
});
