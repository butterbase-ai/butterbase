import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Module mocks (must appear before imports of the mocked modules) ---

const runtimePoolHolder = vi.hoisted(() => ({ value: null as unknown }));
const controlPoolHolder = vi.hoisted(() => ({ value: null as unknown }));

vi.mock('../runtime-db.js', () => ({
  getRuntimeDbPool: vi.fn(() => runtimePoolHolder.value),
}));

const listDatabases = vi.hoisted(() => vi.fn());
const deleteDatabase = vi.hoisted(() => vi.fn());
const withNeonProjectLock = vi.hoisted(() => vi.fn(async (_p: string, fn: () => Promise<unknown>) => fn()));

vi.mock('../neon-client.js', () => ({
  listDatabases,
  deleteDatabase,
  withNeonProjectLock,
}));

vi.mock('../neon-projects.js', () => ({
  getDataProjectIdForRegion: vi.fn((region: string) => `neon-proj-${region}`),
}));

vi.mock('../../config.js', () => ({
  config: { runtimeDb: { urlsByRegion: {} } },
}));

// After mocks
import { reconcileOrphansForRegion, reconcileOrphans } from '../neon-orphan-reconciler.js';

type QueryRow = Record<string, unknown>;

function makePool(handler: (sql: string, params: unknown[]) => { rows: QueryRow[] } | Promise<{ rows: QueryRow[] }>) {
  return {
    query: vi.fn(async (sql: string, params?: unknown[]) => handler(sql, params ?? [])),
  };
}

const REGION = 'us-east-1';
const RUNTIME_CFG = { urlsByRegion: {} } as never;
const NOW = '2026-07-12T09:00:00Z';
const nowMs = new Date(NOW).getTime();

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const DEFAULTS = { graceHours: 24, maxDropsPerRun: 10, dryRun: false, now: NOW };

beforeEach(() => {
  listDatabases.mockReset();
  deleteDatabase.mockReset().mockResolvedValue(undefined);
  withNeonProjectLock.mockClear();
  silentLogger.info.mockReset();
  silentLogger.warn.mockReset();
  silentLogger.error.mockReset();
});

describe('reconcileOrphansForRegion', () => {
  it('drops confirmed orphans (in Neon, not in apps, past grace, no in-flight task)', async () => {
    listDatabases.mockResolvedValue([
      { name: 'db_app_orphan1', createdAt: new Date(nowMs - 48 * 3600 * 1000).toISOString() },
      { name: 'db_app_live1', createdAt: new Date(nowMs - 48 * 3600 * 1000).toISOString() },
    ]);
    runtimePoolHolder.value = makePool((sql) => {
      if (sql.includes('FROM apps')) return { rows: [{ db_name: 'app_live1' }] };
      if (sql.includes('FROM neon_tasks')) return { rows: [] };
      return { rows: [] };
    });

    const res = await reconcileOrphansForRegion(REGION, controlPoolHolder.value as never, RUNTIME_CFG, silentLogger, DEFAULTS);

    expect(res.dropped).toEqual(['db_app_orphan1']);
    expect(res.wouldDrop).toEqual([]);
    expect(deleteDatabase).toHaveBeenCalledWith(`neon-proj-${REGION}`, 'db_app_orphan1');
    expect(deleteDatabase).not.toHaveBeenCalledWith(expect.anything(), 'db_app_live1');
  });

  it('skips young databases inside the grace window', async () => {
    listDatabases.mockResolvedValue([
      { name: 'db_app_fresh', createdAt: new Date(nowMs - 2 * 3600 * 1000).toISOString() },  // 2h old — under 24h grace
    ]);
    runtimePoolHolder.value = makePool((sql) => (sql.includes('FROM apps') ? { rows: [] } : { rows: [] }));

    const res = await reconcileOrphansForRegion(REGION, controlPoolHolder.value as never, RUNTIME_CFG, silentLogger, DEFAULTS);

    expect(res.skippedYoung).toBe(1);
    expect(res.dropped).toEqual([]);
    expect(deleteDatabase).not.toHaveBeenCalled();
  });

  it('skips databases whose app_id has a pending or processing neon_task', async () => {
    listDatabases.mockResolvedValue([
      { name: 'db_app_busy', createdAt: new Date(nowMs - 48 * 3600 * 1000).toISOString() },
    ]);
    runtimePoolHolder.value = makePool((sql) => {
      if (sql.includes('FROM apps')) return { rows: [] };
      if (sql.includes('FROM neon_tasks')) return { rows: [{ app_id: 'app_busy' }] };
      return { rows: [] };
    });

    const res = await reconcileOrphansForRegion(REGION, controlPoolHolder.value as never, RUNTIME_CFG, silentLogger, DEFAULTS);

    expect(res.skippedInflight).toBe(1);
    expect(res.dropped).toEqual([]);
    expect(deleteDatabase).not.toHaveBeenCalled();
  });

  it('respects maxDropsPerRun cap, oldest orphans first', async () => {
    listDatabases.mockResolvedValue([
      { name: 'db_app_a', createdAt: new Date(nowMs - 100 * 3600 * 1000).toISOString() },  // oldest
      { name: 'db_app_b', createdAt: new Date(nowMs - 80 * 3600 * 1000).toISOString() },
      { name: 'db_app_c', createdAt: new Date(nowMs - 60 * 3600 * 1000).toISOString() },
    ]);
    runtimePoolHolder.value = makePool((sql) => (sql.includes('FROM apps') ? { rows: [] } : { rows: [] }));

    const res = await reconcileOrphansForRegion(
      REGION, controlPoolHolder.value as never, RUNTIME_CFG, silentLogger,
      { ...DEFAULTS, maxDropsPerRun: 2 },
    );

    expect(res.eligibleCount).toBe(3);
    expect(res.dropped).toEqual(['db_app_a', 'db_app_b']);
    expect(deleteDatabase).toHaveBeenCalledTimes(2);
  });

  it('in dry-run mode: never calls deleteDatabase; populates wouldDrop', async () => {
    listDatabases.mockResolvedValue([
      { name: 'db_app_orphan', createdAt: new Date(nowMs - 48 * 3600 * 1000).toISOString() },
    ]);
    runtimePoolHolder.value = makePool((sql) => (sql.includes('FROM apps') ? { rows: [] } : { rows: [] }));

    const res = await reconcileOrphansForRegion(
      REGION, controlPoolHolder.value as never, RUNTIME_CFG, silentLogger,
      { ...DEFAULTS, dryRun: true },
    );

    expect(res.wouldDrop).toEqual(['db_app_orphan']);
    expect(res.dropped).toEqual([]);
    expect(deleteDatabase).not.toHaveBeenCalled();
  });

  it('records dropErrors on Neon failure without aborting the batch', async () => {
    listDatabases.mockResolvedValue([
      { name: 'db_app_x', createdAt: new Date(nowMs - 48 * 3600 * 1000).toISOString() },
      { name: 'db_app_y', createdAt: new Date(nowMs - 48 * 3600 * 1000).toISOString() },
    ]);
    runtimePoolHolder.value = makePool((sql) => (sql.includes('FROM apps') ? { rows: [] } : { rows: [] }));
    deleteDatabase.mockRejectedValueOnce(new Error('Neon 423 locked')).mockResolvedValueOnce(undefined);

    const res = await reconcileOrphansForRegion(REGION, controlPoolHolder.value as never, RUNTIME_CFG, silentLogger, DEFAULTS);

    expect(res.dropErrors).toEqual([{ db: expect.any(String), error: expect.stringMatching(/423/) }]);
    expect(res.dropped).toHaveLength(1);
  });

  it('ignores Neon databases that do not match the db_app_ prefix', async () => {
    listDatabases.mockResolvedValue([
      { name: 'db_app_orphan', createdAt: new Date(nowMs - 48 * 3600 * 1000).toISOString() },
      { name: 'neondb', createdAt: new Date(nowMs - 48 * 3600 * 1000).toISOString() },
      { name: 'db_internal_metrics', createdAt: new Date(nowMs - 48 * 3600 * 1000).toISOString() },
    ]);
    runtimePoolHolder.value = makePool((sql) => (sql.includes('FROM apps') ? { rows: [] } : { rows: [] }));

    const res = await reconcileOrphansForRegion(REGION, controlPoolHolder.value as never, RUNTIME_CFG, silentLogger, DEFAULTS);

    expect(res.neonDbCount).toBe(1);
    expect(res.dropped).toEqual(['db_app_orphan']);
  });
});

describe('reconcileOrphans (multi-region driver)', () => {
  it('returns empty result when BUTTERBASE_REGIONS is unset', async () => {
    const prev = process.env.BUTTERBASE_REGIONS;
    delete process.env.BUTTERBASE_REGIONS;
    try {
      const res = await reconcileOrphans(controlPoolHolder.value as never, RUNTIME_CFG, silentLogger, DEFAULTS);
      expect(res).toEqual([]);
      expect(silentLogger.warn).toHaveBeenCalled();
    } finally {
      if (prev !== undefined) process.env.BUTTERBASE_REGIONS = prev;
    }
  });

  it('scans every configured region and does not abort on per-region failure', async () => {
    process.env.BUTTERBASE_REGIONS = 'us-east-1,us-west-2';
    // First region succeeds
    listDatabases
      .mockResolvedValueOnce([{ name: 'db_app_a', createdAt: new Date(nowMs - 48 * 3600 * 1000).toISOString() }])
      // Second region: Neon list blows up — should log and move on
      .mockRejectedValueOnce(new Error('Neon 502'));
    runtimePoolHolder.value = makePool((sql) => (sql.includes('FROM apps') ? { rows: [] } : { rows: [] }));

    const res = await reconcileOrphans(controlPoolHolder.value as never, RUNTIME_CFG, silentLogger, DEFAULTS);

    expect(res).toHaveLength(1);
    expect(res[0].region).toBe('us-east-1');
    expect(silentLogger.error).toHaveBeenCalledWith(expect.objectContaining({ region: 'us-west-2' }), expect.any(String));

    delete process.env.BUTTERBASE_REGIONS;
  });
});
