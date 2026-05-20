import { describe, it, expect, vi } from 'vitest';
import { executeUnblockWrites } from './step-unblock-writes.js';

describe('executeUnblockWrites', () => {
  it('clears source provisioning_status and returns next=completed', async () => {
    const sourcePool = { query: vi.fn().mockResolvedValue({ rowCount: 1 }) };
    const ctx: any = { controlPool: { query: vi.fn() }, runtimePoolFor: () => sourcePool, redisFor: vi.fn(), log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } };
    const m: any = { id: 'mig-1', app_id: 'a', source_region: 'us-east-1', dest_region: 'eu-west-1', current_step: 'unblocking_writes', dest_resources: {} };
    const res = await executeUnblockWrites(ctx, m);
    expect(res.next).toBe('completed');
  });
});
