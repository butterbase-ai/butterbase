import { describe, it, expect, vi } from 'vitest';
import { executeReverseReplication } from './step-reverse-replication.js';

const baseM = (over: any = {}) => ({
  id: 'mig-1', app_id: 'a', user_id: 'u', source_region: 'us-east-1', dest_region: 'eu-west-1',
  current_step: 'setting_up_reverse_replication', dest_resources: {}, retry_count: 0, ...over,
});

describe('executeReverseReplication', () => {
  it('happy path: configures replication, sets state=replicating, advances to unblocking_writes', async () => {
    const controlPool: any = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const configure = vi.fn().mockResolvedValue({ slotName: 'slot_x' });
    const ctx: any = { controlPool, runtimePoolFor: vi.fn(), redisFor: vi.fn(), log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, configureNeonReplication: configure };
    const res = await executeReverseReplication(ctx, baseM());
    expect(res.next).toBe('unblocking_writes');
    expect(res.patch).toMatchObject({ replication_slot: 'slot_x' });
    expect(res.sourceReplicaState).toBe('replicating');
    expect(configure).toHaveBeenCalledOnce();
  });

  it('idempotent: already has slot → just bumps state and proceeds', async () => {
    const controlPool: any = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const configure = vi.fn();
    const ctx: any = { controlPool, runtimePoolFor: vi.fn(), redisFor: vi.fn(), log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, configureNeonReplication: configure };
    const res = await executeReverseReplication(ctx, baseM({ dest_resources: { replication_slot: 'existing' } }));
    expect(res.next).toBe('unblocking_writes');
    expect(res.sourceReplicaState).toBe('replicating');
    expect(configure).not.toHaveBeenCalled();
  });

  it('not injected: warns, marks none, advances', async () => {
    const controlPool: any = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const ctx: any = { controlPool, runtimePoolFor: vi.fn(), redisFor: vi.fn(), log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } };
    const res = await executeReverseReplication(ctx, baseM());
    expect(res.next).toBe('unblocking_writes');
    expect(res.patch).toMatchObject({ reverse_replication_skipped: 'not_injected' });
    expect(res.sourceReplicaState).toBe('none');
  });

  it('give-up after MAX_TRIES: marks none, advances', async () => {
    const controlPool: any = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const configure = vi.fn().mockRejectedValue(new Error('502'));
    const ctx: any = { controlPool, runtimePoolFor: vi.fn(), redisFor: vi.fn(), log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, configureNeonReplication: configure };
    const res = await executeReverseReplication(ctx, baseM({ retry_count: 2 }));
    expect(res.next).toBe('unblocking_writes');
    expect(res.patch).toMatchObject({ reverse_replication_skipped: 'gave_up' });
    expect(res.sourceReplicaState).toBe('none');
  });

  it('still has retries left: re-throws', async () => {
    const controlPool: any = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const configure = vi.fn().mockRejectedValue(new Error('boom'));
    const ctx: any = { controlPool, runtimePoolFor: vi.fn(), redisFor: vi.fn(), log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, configureNeonReplication: configure };
    await expect(executeReverseReplication(ctx, baseM())).rejects.toThrow('boom');
  });
});
