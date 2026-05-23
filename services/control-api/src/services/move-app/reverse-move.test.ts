import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runReverseMove } from './reverse-move.js';

vi.mock('./migration-store.js', () => ({
  getMigration: vi.fn(),
  createMigration: vi.fn(),
  markCompleted: vi.fn(),
}));

import { getMigration, createMigration, markCompleted } from './migration-store.js';

describe('runReverseMove', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('promotes source replica, flips routing back, unarchives rows', async () => {
    (getMigration as any).mockResolvedValue({
      id: 'fwd-1',
      app_id: 'app-x',
      user_id: 'u-1',
      source_region: 'us-east-1',
      dest_region: 'eu-west-1',
      current_step: 'completed',
      source_replica_state: 'replicating',
    });
    (createMigration as any).mockResolvedValue('rev-1');
    (markCompleted as any).mockResolvedValue(undefined);

    const sourcePool = {
      query: vi.fn().mockImplementation(async (sql: string) => {
        if (sql.includes('SELECT subdomain')) return { rows: [{ subdomain: 'demo' }] };
        return { rows: [] };
      }),
    };
    const destPool = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const controlPool = { query: vi.fn().mockResolvedValue({ rows: [] }) };

    const writeSubdomainMapping = vi.fn().mockResolvedValue(undefined);
    const writeDomainMapping = vi.fn().mockResolvedValue(undefined);
    const listCustomDomains = vi.fn().mockResolvedValue([{ hostname: 'a.example.com' }]);
    const invalidateCacheAllRegions = vi.fn().mockResolvedValue(undefined);
    const updateUserAppIndexRegion = vi.fn().mockResolvedValue(undefined);
    const waitForReplicationCaughtUp = vi.fn().mockResolvedValue(undefined);
    const promoteSourceToPrimary = vi.fn().mockResolvedValue(undefined);

    const ctx: any = {
      controlPool,
      runtimePoolFor: (r: string) => (r === 'us-east-1' ? sourcePool : destPool),
      writeSubdomainMapping,
      writeDomainMapping,
      listCustomDomains,
      invalidateCacheAllRegions,
      updateUserAppIndexRegion,
      waitForReplicationCaughtUp,
      promoteSourceToPrimary,
    };

    const res = await runReverseMove(ctx, { forwardMigrationId: 'fwd-1', userId: 'u-1' });
    expect(res.migrationId).toBe('rev-1');
    expect(res.path).toBe('fast');
    expect(waitForReplicationCaughtUp).toHaveBeenCalledWith('us-east-1', 'app-x', 'fwd-1');
    expect(promoteSourceToPrimary).toHaveBeenCalledWith('us-east-1', 'app-x', 'fwd-1');
    expect(updateUserAppIndexRegion).toHaveBeenCalledWith(controlPool, 'app-x', 'us-east-1');
    expect(writeSubdomainMapping).toHaveBeenCalledWith('demo', 'app-x', 'us-east-1');
    expect(writeDomainMapping).toHaveBeenCalledWith('a.example.com', 'app-x', 'us-east-1');
    expect(invalidateCacheAllRegions).toHaveBeenCalledWith('app-x');
    expect(markCompleted).toHaveBeenCalledWith(controlPool, 'rev-1');

    // Dest set to migrating
    expect(destPool.query).toHaveBeenCalledWith(
      expect.stringContaining(`provisioning_status = 'migrating'`),
      ['app-x'],
    );
    // Source set to ready with restored region
    expect(sourcePool.query).toHaveBeenCalledWith(
      expect.stringContaining(`provisioning_status = 'ready'`),
      ['us-east-1', 'app-x'],
    );
    // Unarchive happened against source pool
    const unarchiveCall = sourcePool.query.mock.calls.find((c: any[]) =>
      typeof c[0] === 'string' && c[0].includes('archived_after_move = NULL'),
    );
    expect(unarchiveCall).toBeTruthy();
  });

  it('fast path: emits a warn log noting the KV split-region gap', async () => {
    (getMigration as any).mockResolvedValue({
      id: 'fwd-1',
      app_id: 'app-x',
      user_id: 'u-1',
      source_region: 'us-east-1',
      dest_region: 'eu-west-1',
      current_step: 'completed',
      source_replica_state: 'replicating',
    });
    (createMigration as any).mockResolvedValue('rev-warn-1');
    (markCompleted as any).mockResolvedValue(undefined);

    const sourcePool = {
      query: vi.fn().mockImplementation(async (sql: string) => {
        if (sql.includes('SELECT subdomain')) return { rows: [{ subdomain: 'demo' }] };
        return { rows: [] };
      }),
    };
    const destPool = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const logWarn = vi.fn();

    const ctx: any = {
      controlPool: { query: vi.fn().mockResolvedValue({ rows: [] }) },
      runtimePoolFor: (r: string) => (r === 'us-east-1' ? sourcePool : destPool),
      writeSubdomainMapping: vi.fn().mockResolvedValue(undefined),
      writeDomainMapping: vi.fn().mockResolvedValue(undefined),
      listCustomDomains: vi.fn().mockResolvedValue([]),
      invalidateCacheAllRegions: vi.fn().mockResolvedValue(undefined),
      updateUserAppIndexRegion: vi.fn().mockResolvedValue(undefined),
      waitForReplicationCaughtUp: vi.fn().mockResolvedValue(undefined),
      promoteSourceToPrimary: vi.fn().mockResolvedValue(undefined),
      log: { warn: logWarn },
    };

    await runReverseMove(ctx, { forwardMigrationId: 'fwd-1', userId: 'u-1' });

    expect(logWarn).toHaveBeenCalledOnce();
    const [obj, msg] = logWarn.mock.calls[0];
    expect(obj).toMatchObject({
      forwardMigrationId: 'fwd-1',
      appId: 'app-x',
      kvRegion: 'eu-west-1',
      pgRegion: 'us-east-1',
    });
    expect(msg).toContain('[reverse-move fast-path]');
  });

  it('rejects when forward migration is not completed', async () => {
    (getMigration as any).mockResolvedValueOnce({
      id: 'fwd-3',
      app_id: 'app-x',
      source_region: 'us-east-1',
      dest_region: 'eu-west-1',
      current_step: 'flipping_routing',
      source_replica_state: 'replicating',
    });
    const ctx: any = {
      controlPool: { query: vi.fn() },
      runtimePoolFor: () => ({ query: vi.fn() }),
      writeSubdomainMapping: vi.fn(),
      writeDomainMapping: vi.fn(),
      listCustomDomains: vi.fn(),
      invalidateCacheAllRegions: vi.fn(),
      updateUserAppIndexRegion: vi.fn(),
      waitForReplicationCaughtUp: vi.fn(),
      promoteSourceToPrimary: vi.fn(),
    };
    await expect(
      runReverseMove(ctx, { forwardMigrationId: 'fwd-3', userId: 'u-1' }),
    ).rejects.toThrow(/completed/);
  });

  it('slow path: source_replica_state=none → creates swapped-direction migration', async () => {
    const forward = {
      id: 'fwd-2', app_id: 'app-x', user_id: 'u', source_region: 'us-east-1',
      dest_region: 'eu-west-1', current_step: 'completed', source_replica_state: 'none',
      dest_resources: {}, retry_count: 0, last_error: null, completed_at: new Date(),
      initiated_at: new Date(), step_started_at: new Date(),
    };
    (getMigration as any).mockResolvedValue(forward);
    (createMigration as any).mockResolvedValue('rev-slow-1');

    const runtimePool = { query: vi.fn().mockResolvedValue({ rowCount: 0 }) };
    const ctx: any = {
      controlPool: { query: vi.fn().mockResolvedValue({ rows: [] }) },
      runtimePoolFor: (_region: string) => runtimePool,
      writeSubdomainMapping: vi.fn(),
      writeDomainMapping: vi.fn(),
      listCustomDomains: vi.fn().mockResolvedValue([]),
      invalidateCacheAllRegions: vi.fn(),
      updateUserAppIndexRegion: vi.fn(),
      waitForReplicationCaughtUp: vi.fn(),
      promoteSourceToPrimary: vi.fn(),
    };

    const r = await runReverseMove(ctx, { forwardMigrationId: 'fwd-2', userId: 'u' });
    expect(r.migrationId).toBe('rev-slow-1');
    expect(r.path).toBe('slow');

    // Verify archived_after_move clearing was attempted (at least one UPDATE call)
    const updateCalls = (runtimePool.query as any).mock.calls.filter(
      (c: any) => c[0].includes('SET archived_after_move = NULL'),
    );
    expect(updateCalls.length).toBeGreaterThan(0);

    // Fast-path operations should NOT have been called
    expect(ctx.waitForReplicationCaughtUp).not.toHaveBeenCalled();
    expect(ctx.promoteSourceToPrimary).not.toHaveBeenCalled();
  });
});
