import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- Module mocks (must appear before any imports of mocked modules) ---

vi.mock('../runtime-db.js', () => ({
  getRuntimeDbPool: vi.fn(),
}));

vi.mock('../neon-client.js', () => ({
  withNeonProjectLock: vi.fn(async (_projectId: string, fn: () => Promise<void>) => fn()),
  ensureRoleExists: vi.fn().mockResolvedValue(undefined),
  createDatabase: vi.fn().mockResolvedValue(undefined),
  getConnectionString: vi.fn().mockResolvedValue({
    connectionUri: 'postgres://neon-host/db_app1',
    poolerHost: null,
    pooledConnectionUri: null,
  }),
  grantSchemaPrivileges: vi.fn().mockResolvedValue(undefined),
  deleteDatabase: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../neon-projects.js', () => ({
  getDataProjectIdForRegion: vi.fn((region: string) => {
    if (region === 'us-east-1') return 'neon-proj-us-east-1';
    throw new Error(`Missing env var NEON_DATA_PROJECT_ID_${region.toUpperCase().replace(/-/g, '_')} for region ${region}`);
  }),
}));

vi.mock('../provisioner.js', () => ({
  runMigrationsWithRetry: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../migrator.js', () => ({
  runDataPlaneMigrations: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../failure-notifications.service.js', () => ({
  notifyProvisioningFailed: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../config.js', () => ({
  config: {
    neon: {
      enabled: true,
      databaseOwner: 'owner_role',
      dataProjectId: 'legacy-project-id', // should NOT be used after this task
    },
    runtimeDb: { urlsByRegion: { 'us-east-1': 'postgres://runtime' } },
    dataPlaneDb: { user: 'dev', password: 'dev' },
    pgbouncer: { host: 'localhost', port: 5432 },
  },
  assertRegionConfig: vi.fn(() => ({ instanceRegion: 'us-east-1', regions: ['us-east-1'] })),
}));

// --- Imports after mocks ---
import { startNeonTaskWorker } from '../neon-task-worker.js';
import { getRuntimeDbPool } from '../runtime-db.js';
import * as neonClient from '../neon-client.js';
import { getDataProjectIdForRegion } from '../neon-projects.js';

const APP_ID = 'app-test-123';
const REGION = 'us-east-1';

// Helper: build a mock pg.Pool with a queue of responses
function makeMockPool(queryResponses: Array<{ rows: unknown[]; rowCount?: number }> = []) {
  const responses = [...queryResponses];
  return {
    query: vi.fn(async () => responses.shift() ?? { rows: [], rowCount: 0 }),
    connect: vi.fn(async () => ({
      query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
      release: vi.fn(),
    })),
  } as any;
}

describe('neon-task-worker: executeProvision uses per-region data project', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls getDataProjectIdForRegion with the region from apps table', async () => {
    // runtimePool.query call sequence for executeProvision:
    //   1. SELECT region FROM apps WHERE id = $1  → { rows: [{ region: 'us-east-1' }] }
    //   2. INSERT INTO app_db_connections ...      → { rows: [] }
    //   3. UPDATE apps SET db_provisioned ...      → { rows: [] }
    const runtimePool = makeMockPool([
      { rows: [{ region: REGION }] },  // region lookup
      { rows: [] },                    // INSERT app_db_connections
      { rows: [] },                    // UPDATE apps
    ]);

    // controlDb.query sequence:
    //   1. stale recovery reset UPDATE       → { rows: [], rowCount: 0 }
    //   2. stale recovery fail UPDATE        → { rows: [], rowCount: 0 }
    //   3. claim task UPDATE ... RETURNING   → task row
    //   4. mark completed UPDATE             → { rows: [] }
    const controlDb = makeMockPool([
      { rows: [], rowCount: 0 },  // stale recovery: reset
      { rows: [], rowCount: 0 },  // stale recovery: fail
      {
        rows: [{
          id: 1,
          app_id: APP_ID,
          task_type: 'provision',
          status: 'processing',
          attempts: 1,
          max_attempts: 3,
          last_error: null,
          locked_at: null,
          run_after: new Date(),
          created_at: new Date(),
        }],
        rowCount: 1,
      },
      { rows: [], rowCount: 1 },  // mark completed
    ]);

    const dataPlaneDb = makeMockPool();
    (getRuntimeDbPool as any).mockReturnValue(runtimePool);

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const interval = startNeonTaskWorker(controlDb, dataPlaneDb, logger);

    // Advance fake timers past the 1s poll interval and flush all async work
    await vi.advanceTimersByTimeAsync(1100);
    clearInterval(interval);

    // The region lookup should have been called with the per-app region
    expect(getDataProjectIdForRegion).toHaveBeenCalledWith(REGION);

    // Neon client should use the resolved project id, NOT the legacy one
    expect(neonClient.withNeonProjectLock).toHaveBeenCalledWith('neon-proj-us-east-1', expect.any(Function));
    expect(neonClient.ensureRoleExists).toHaveBeenCalledWith('neon-proj-us-east-1', 'owner_role');
    expect(neonClient.createDatabase).toHaveBeenCalledWith('neon-proj-us-east-1', `db_${APP_ID}`, 'owner_role');
    expect(neonClient.getConnectionString).toHaveBeenCalledWith('neon-proj-us-east-1', `db_${APP_ID}`, 'owner_role');
    expect(neonClient.grantSchemaPrivileges).toHaveBeenCalledWith('neon-proj-us-east-1', `db_${APP_ID}`, 'owner_role');
  });

  it('throws and logs task failure when app is not found in apps table', async () => {
    // runtimePool returns empty rows — app not found
    const emptyRuntimePool = makeMockPool([
      { rows: [] }, // no app found for region lookup
    ]);
    (getRuntimeDbPool as any).mockReturnValue(emptyRuntimePool);

    // controlDb: stale recovery (2 queries) + claim task + retry update (backoff)
    const controlDb = makeMockPool([
      { rows: [], rowCount: 0 },  // stale recovery: reset
      { rows: [], rowCount: 0 },  // stale recovery: fail
      {
        rows: [{
          id: 2,
          app_id: 'missing-app',
          task_type: 'provision',
          status: 'processing',
          attempts: 1,
          max_attempts: 3,
          last_error: null,
          locked_at: null,
          run_after: new Date(),
          created_at: new Date(),
        }],
        rowCount: 1,
      },
      { rows: [], rowCount: 1 },  // retry update (backoff)
    ]);

    const dataPlaneDb = makeMockPool();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const interval = startNeonTaskWorker(controlDb, dataPlaneDb, logger);
    await vi.advanceTimersByTimeAsync(1100);
    clearInterval(interval);

    // The error should have been logged as a task failure
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining('missing-app') }),
      expect.stringContaining('[neon-task-worker] Task failed'),
    );
  });
});
