// Regressions for acknowledged pause/resume mutations during the long copy phase.
import { describe, it, expect, vi } from 'vitest';
vi.mock('../app-state-lock.js', () => ({ withAppStateLocks: async (_pool: unknown, ids: string[], work: Function) =>
  work(ids.map(app_id=>({ app_id,region:'b',organization_id:null })),{ query: async()=>({ rows:[] }) }) }));
vi.mock('./migration-store.js', () => ({
  getMigration: vi.fn(async () => ({ id: 'fwd', app_id: 'app_race', source_region: 'a', dest_region: 'b', current_step: 'completed', source_replica_state: 'replicating' })),
  createMigration: vi.fn(async () => 'reverse'), markCompleted: vi.fn(async () => {}),
}));
import { runReverseMove } from './reverse-move.js';

describe('pause mutation during reverse cutover', () => {
  it.each([false,true])('preserves a pause/resume acknowledged during replication wait (initial paused=%s)', async (initial) => {
    let homePaused = initial, restoredPaused = initial;
    const source = { query: vi.fn(async (sql: string, params: unknown[]) => {
      if (sql.includes('SET paused = $2')) restoredPaused = params[1] as boolean;
      return { rows: [{ subdomain: 'race', paused: restoredPaused }] };
    }) };
    const current = { query: vi.fn(async () => ({ rows: [{ paused: homePaused, paused_by: homePaused ? 'idle_reaper' : null }] })) };
    const mapping = vi.fn();
    await runReverseMove({
      controlPool: {} as never, runtimePoolFor: (r) => (r === 'a' ? source : current) as never,
      writeSubdomainMapping: mapping, writeDomainMapping: vi.fn(), listCustomDomains: async () => [],
      invalidateCacheAllRegions: vi.fn(), updateOrgAppIndexRegion: vi.fn(),
      waitForReplicationCaughtUp: async () => { homePaused = !initial; }, // An acknowledged owner pause / paid upgrade resume.
      promoteSourceToPrimary: vi.fn(), dumpKvFromRegion: async () => ({ key: 'test', records: 0 }),
      clearKvScope: async () => 0, restoreKvIntoRegion: async () => ({ records: 0 }),
    } as never, { forwardMigrationId: 'fwd', userId: 'owner' });
    expect(restoredPaused).toBe(homePaused);
    expect(mapping).toHaveBeenCalledWith('race','app_race','a',homePaused);
  });
});
