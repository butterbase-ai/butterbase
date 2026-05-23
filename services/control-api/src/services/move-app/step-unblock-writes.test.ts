import { describe, it, expect, vi } from 'vitest';

// vi.mock is hoisted before variable declarations, so mocks must use vi.fn() inline.
vi.mock('../kv/migration-sentinel.js', () => ({ clearKvBlock: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../kv/redis-registry.js', () => ({ kvRedisFor: vi.fn().mockReturnValue({}) }));
vi.mock('../kv/redis-client.js', () => ({ wrap: vi.fn().mockImplementation((r: any) => r) }));

import { executeUnblockWrites } from './step-unblock-writes.js';
import { clearKvBlock } from '../kv/migration-sentinel.js';
import { kvRedisFor } from '../kv/redis-registry.js';

describe('executeUnblockWrites', () => {
  it('clears source provisioning_status and returns next=completed', async () => {
    const sourcePool = { query: vi.fn().mockResolvedValue({ rowCount: 1 }) };
    const ctx: any = { controlPool: { query: vi.fn() }, runtimePoolFor: () => sourcePool, redisFor: vi.fn(), log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } };
    const m: any = { id: 'mig-1', app_id: 'a', source_region: 'us-east-1', dest_region: 'eu-west-1', current_step: 'unblocking_writes', dest_resources: {} };
    const res = await executeUnblockWrites(ctx, m);
    expect(res.next).toBe('completed');
  });

  it('calls clearKvBlock for the source region app', async () => {
    vi.mocked(clearKvBlock).mockClear();
    const sourcePool = { query: vi.fn().mockResolvedValue({ rowCount: 1 }) };
    const ctx: any = { controlPool: { query: vi.fn() }, runtimePoolFor: () => sourcePool, redisFor: vi.fn(), log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } };
    const m: any = { id: 'mig-1', app_id: 'app-x', source_region: 'us', dest_region: 'eu', current_step: 'unblocking_writes', dest_resources: {} };

    await executeUnblockWrites(ctx, m);

    expect(clearKvBlock).toHaveBeenCalledOnce();
    expect(clearKvBlock).toHaveBeenCalledWith(expect.anything(), m.app_id);
  });

  it('calls kvRedisFor with source_region', async () => {
    vi.mocked(kvRedisFor).mockClear();
    const sourcePool = { query: vi.fn().mockResolvedValue({ rowCount: 1 }) };
    const ctx: any = { controlPool: { query: vi.fn() }, runtimePoolFor: () => sourcePool, redisFor: vi.fn(), log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } };
    const m: any = { id: 'mig-1', app_id: 'app-x', source_region: 'us', dest_region: 'eu', current_step: 'unblocking_writes', dest_resources: {} };

    await executeUnblockWrites(ctx, m);

    expect(kvRedisFor).toHaveBeenCalledWith(m.source_region);
  });

  it('still returns next=completed even if clearKvBlock throws', async () => {
    vi.mocked(clearKvBlock).mockRejectedValueOnce(new Error('Redis unavailable'));
    const sourcePool = { query: vi.fn().mockResolvedValue({ rowCount: 1 }) };
    const ctx: any = { controlPool: { query: vi.fn() }, runtimePoolFor: () => sourcePool, redisFor: vi.fn(), log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } };
    const m: any = { id: 'mig-1', app_id: 'app-x', source_region: 'us', dest_region: 'eu', current_step: 'unblocking_writes', dest_resources: {} };

    const res = await executeUnblockWrites(ctx, m);
    expect(res.next).toBe('completed');
    expect(ctx.log.warn).toHaveBeenCalledOnce();
  });
});
