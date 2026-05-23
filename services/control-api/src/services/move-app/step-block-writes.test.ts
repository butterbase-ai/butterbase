import { describe, it, expect, vi } from 'vitest';

// vi.mock is hoisted before variable declarations, so mocks must use vi.fn() inline.
vi.mock('../kv/migration-sentinel.js', () => ({ setKvBlock: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../kv/redis-registry.js', () => ({ kvRedisFor: vi.fn().mockReturnValue({}) }));
vi.mock('../kv/redis-client.js', () => ({ wrap: vi.fn().mockImplementation((r: any) => r) }));
vi.mock('../region-resolver.js', () => ({ invalidateAppRegion: vi.fn().mockResolvedValue(undefined) }));

import { executeBlockWrites } from './step-block-writes.js';
import { setKvBlock } from '../kv/migration-sentinel.js';
import { kvRedisFor } from '../kv/redis-registry.js';

const makeCtx = (): any => {
  const queryFn = vi.fn().mockResolvedValue({ rowCount: 1 });
  return {
    controlPool: { query: queryFn },
    runtimePoolFor: vi.fn().mockReturnValue({ query: queryFn }),
    redisFor: vi.fn().mockReturnValue({}),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    _queryFn: queryFn,
  };
};

const makeMigration = (): any => ({
  id: 'mig-1',
  app_id: 'app-x',
  source_region: 'us',
  dest_region: 'eu',
  current_step: 'blocking_writes',
  dest_resources: {},
});

describe('executeBlockWrites', () => {
  it('sets provisioning_status to migrating and advances to dumping_data', async () => {
    const ctx = makeCtx();
    const m = makeMigration();

    const res = await executeBlockWrites(ctx, m);

    expect(res.next).toBe('dumping_data');
    expect(res.patch).toEqual({});
    expect(ctx._queryFn).toHaveBeenCalledWith(
      expect.stringContaining("provisioning_status = 'migrating'"),
      [m.app_id],
    );
  });

  it('calls setKvBlock for the source region app', async () => {
    vi.mocked(setKvBlock).mockClear();
    const ctx = makeCtx();
    const m = makeMigration();

    await executeBlockWrites(ctx, m);

    expect(setKvBlock).toHaveBeenCalledOnce();
    expect(setKvBlock).toHaveBeenCalledWith(expect.anything(), m.app_id);
  });

  it('calls kvRedisFor with source_region', async () => {
    vi.mocked(kvRedisFor).mockClear();
    const ctx = makeCtx();
    const m = makeMigration();

    await executeBlockWrites(ctx, m);

    expect(kvRedisFor).toHaveBeenCalledWith(m.source_region);
  });
});
