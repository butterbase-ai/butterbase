import { describe, it, expect, vi } from 'vitest';

// vi.mock is hoisted before variable declarations, so mocks must use vi.fn() inline.
vi.mock('../kv/migration-sentinel.js', () => ({ clearKvBlock: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../kv/redis-registry.js', () => ({ kvRedisFor: vi.fn().mockReturnValue({}) }));
vi.mock('../kv/redis-client.js', () => ({ wrap: vi.fn().mockImplementation((r: any) => r) }));
vi.mock('../region-resolver.js', () => ({ invalidateAppRegion: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../neon-client.js', () => ({
  withNeonProjectLock: vi.fn().mockImplementation((_id: string, fn: () => Promise<void>) => fn()),
  deleteDatabase: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../neon-projects.js', () => ({ getDataProjectIdForRegion: vi.fn().mockReturnValue('proj-123') }));

import { executeAbort } from './step-abort.js';
import { clearKvBlock } from '../kv/migration-sentinel.js';
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

const makeMigration = (overrides: Record<string, unknown> = {}): any => ({
  id: 'mig-1',
  app_id: 'app-x',
  source_region: 'us',
  dest_region: 'eu',
  current_step: 'aborting',
  dest_resources: {},
  ...overrides,
});

describe('executeAbort', () => {
  it('returns next=aborted even when dest_app_id and neon_db_name are not set', async () => {
    const ctx = makeCtx();
    const m = makeMigration();

    const res = await executeAbort(ctx, m);

    expect(res.next).toBe('aborted');
    expect(res.patch).toEqual({});
  });

  it('runs dest cleanup + source restore + cache invalidation + sentinel clear when dest_app_id is set', async () => {
    vi.mocked(clearKvBlock).mockClear();
    vi.mocked(kvRedisFor).mockClear();

    const ctx = makeCtx();
    const m = makeMigration({ dest_resources: { dest_app_id: 'dest-app-y' } });

    const res = await executeAbort(ctx, m);

    expect(res.next).toBe('aborted');
    // dest cleanup: DELETE apps + DELETE app_db_connections
    expect(ctx._queryFn).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM apps'),
      [m.app_id],
    );
    // source restore
    expect(ctx._queryFn).toHaveBeenCalledWith(
      expect.stringContaining("provisioning_status = 'ready'"),
      [m.app_id],
    );
    // sentinel cleared for both regions
    expect(clearKvBlock).toHaveBeenCalledTimes(2);
    expect(kvRedisFor).toHaveBeenCalledWith(m.source_region);
    expect(kvRedisFor).toHaveBeenCalledWith(m.dest_region);
  });

  it('still returns next=aborted even if clearKvBlock throws for both regions', async () => {
    vi.mocked(clearKvBlock).mockRejectedValue(new Error('Redis down'));

    const ctx = makeCtx();
    const m = makeMigration();

    const res = await executeAbort(ctx, m);

    expect(res.next).toBe('aborted');
    expect(ctx.log.warn).toHaveBeenCalledTimes(2); // one per region
  });

  it('still returns next=aborted even if dest query throws', async () => {
    const queryFn = vi.fn().mockRejectedValue(new Error('DB error'));
    const ctx: any = {
      controlPool: { query: vi.fn() },
      runtimePoolFor: vi.fn().mockReturnValue({ query: queryFn }),
      redisFor: vi.fn().mockReturnValue({}),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };
    const m = makeMigration({ dest_resources: { dest_app_id: 'dest-app-y' } });

    const res = await executeAbort(ctx, m);

    expect(res.next).toBe('aborted');
    expect(ctx.log.warn).toHaveBeenCalled();
  });
});
