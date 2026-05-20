import { describe, it, expect, vi } from 'vitest';
import { driveOnce } from './saga-executor.js';
import type { MigrationRow } from './migration-store.js';

const makeRow = (overrides: Partial<MigrationRow> = {}): MigrationRow => ({
  id: 'mig-1',
  app_id: 'app-1',
  user_id: 'user-1',
  source_region: 'us-east-1',
  dest_region: 'eu-west-1',
  current_step: 'requested',
  step_started_at: new Date(),
  last_error: null,
  retry_count: 0,
  dest_resources: {},
  source_replica_state: null,
  initiated_at: new Date(),
  completed_at: null,
  ...overrides,
});

const makeCtx = (rowsSequence: any[][] = [[]]) => {
  const queryFn = vi.fn();
  for (const rows of rowsSequence) queryFn.mockResolvedValueOnce({ rows });
  queryFn.mockResolvedValue({ rows: [] }); // fallback
  const client = { query: queryFn, release: vi.fn() };
  const controlPool: any = { connect: vi.fn().mockResolvedValue(client), query: queryFn };
  return {
    controlPool,
    runtimePoolFor: vi.fn(),
    redisFor: vi.fn(),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    _client: client,
  };
};

describe('driveOnce', () => {
  it('does nothing when no pending migrations', async () => {
    // rowsSequence: first call (BEGIN) returns no rows, second call (SELECT) returns []
    const ctx = makeCtx([[], []]);
    const handler = vi.fn();

    await driveOnce(ctx, { requested: handler });

    expect(handler).not.toHaveBeenCalled();
    expect(ctx._client.release).toHaveBeenCalledOnce();
  });

  it('advances the picked migration when the step handler succeeds', async () => {
    const row = makeRow({ current_step: 'requested', retry_count: 0 });
    // sequence: BEGIN (empty rows), SELECT returns [row], subsequent calls fallback
    const ctx = makeCtx([[], [row]]);
    const handler = vi.fn().mockResolvedValue({ next: 'reserving_dest', patch: {} });

    await driveOnce(ctx, { requested: handler });

    expect(handler).toHaveBeenCalledOnce();

    const calls: string[] = ctx._client.query.mock.calls.map((c: any[]) =>
      typeof c[0] === 'string' ? c[0] : '',
    );
    const updateCall = ctx._client.query.mock.calls.find(
      (c: any[]) =>
        typeof c[0] === 'string' &&
        c[0].includes('UPDATE app_migrations') &&
        c[1]?.includes('reserving_dest'),
    );
    expect(updateCall).toBeDefined();
    expect(ctx._client.release).toHaveBeenCalledOnce();
  });

  it('writes sourceReplicaState as part of the advancing UPDATE when handler returns it', async () => {
    const row = makeRow({ current_step: 'setting_up_reverse_replication', retry_count: 0 });
    const ctx = makeCtx([[], [row]]);
    const handler = vi.fn().mockResolvedValue({
      next: 'unblocking_writes',
      patch: { replication_slot: 'slot_x' },
      sourceReplicaState: 'replicating',
    });

    await driveOnce(ctx, { setting_up_reverse_replication: handler });

    expect(handler).toHaveBeenCalledOnce();
    const updateCall = ctx._client.query.mock.calls.find(
      (c: any[]) =>
        typeof c[0] === 'string' &&
        c[0].includes('UPDATE app_migrations') &&
        c[0].includes('source_replica_state') &&
        Array.isArray(c[1]) &&
        c[1].includes('unblocking_writes'),
    );
    expect(updateCall).toBeDefined();
    // params: [id, next, patchJson, sourceReplicaState]
    expect(updateCall![1][3]).toBe('replicating');
    expect(ctx._client.release).toHaveBeenCalledOnce();
  });

  it('records an error and does not advance on handler throw', async () => {
    const row = makeRow({ current_step: 'requested', retry_count: 0 });
    const ctx = makeCtx([[], [row]]);
    const handler = vi.fn().mockRejectedValue(new Error('something broke'));

    await driveOnce(ctx, { requested: handler });

    const errorUpdateCall = ctx._client.query.mock.calls.find(
      (c: any[]) =>
        typeof c[0] === 'string' && c[0].includes('last_error'),
    );
    expect(errorUpdateCall).toBeDefined();
    expect(ctx._client.release).toHaveBeenCalledOnce();
  });
});
