import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- Module mocks (must appear before any imports of mocked modules) ---

vi.mock('../runtime-db.js', () => ({
  getRuntimeDbPool: vi.fn(),
}));

// executeProvision uses getRuntimeDbForApp(controlDb, appId) to reach the
// app's home-region runtime pool. Forward to the shared holder that the
// tests wire via setMockRuntimePool, so existing per-test query queues drive
// the in-app code unchanged.
const runtimePoolHolder = vi.hoisted(() => ({ value: null as unknown }));
vi.mock('../region-resolver.js', () => ({
  getRuntimeDbForApp: vi.fn(async () => runtimePoolHolder.value),
  resolveAppHomeRegion: vi.fn(async () => 'us-east-1'),
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

// neon-task-worker transitively imports repo-storage, quota-enforcement,
// cloudflare-client, etc., each of which reads its own config.<section> at
// module-load time. Rather than enumerate every section, wrap the explicit
// stubs in a Proxy that returns a permissive empty object for anything else.
// Defined inside the mock factory because vi.mock is hoisted above any const
// declarations in the test file.
vi.mock('../../config.js', () => {
  const configStub: Record<string, unknown> = {
    neon: {
      enabled: true,
      databaseOwner: 'owner_role',
      dataProjectId: 'legacy-project-id', // should NOT be used after this task
    },
    runtimeDb: { urlsByRegion: { 'us-east-1': 'postgres://runtime' } },
    dataPlaneDb: { user: 'dev', password: 'dev' },
    pgbouncer: { host: 'localhost', port: 5432 },
    s3: { accessKeyId: '', secretAccessKey: '', region: 'auto', endpoint: 'https://s3.example.com', forcePathStyle: false },
    ses: { accessKeyId: '', secretAccessKey: '', region: 'us-east-1', fromAddress: 'noreply@example.com' },
    cloudflare: { enabled: false, accountId: 'acct_test', apiToken: 'tok_test' },
  };
  const permissive = new Proxy(configStub, {
    get(target, prop) {
      if (prop in target) return target[prop as string];
      return {};
    },
  });
  return {
    config: permissive,
    assertRegionConfig: vi.fn(() => ({ instanceRegion: 'us-east-1', regions: ['us-east-1'] })),
  };
});

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
    // neon_tasks is a per-region runtime-tier table now, so BOTH stale recovery
    // and claim queries go to runtimePool. Plus the apps-region lookup +
    // INSERT/UPDATE in executeProvision use the same per-app runtimePool (we
    // forward getRuntimeDbForApp to the same mock pool below).
    //
    // runtimePool.query call sequence:
    //   1. recoverStaleTasks: reset UPDATE      → { rows: [], rowCount: 0 }
    //   2. recoverStaleTasks: fail UPDATE       → { rows: [], rowCount: 0 }
    //   3. processNextTask: claim UPDATE        → task row
    //   4. executeProvision: SELECT region      → { rows: [{ region }] }
    //   5. executeProvision: INSERT app_db_connections
    //   6. executeProvision: UPDATE apps SET db_provisioned
    //   7. processNextTask: mark completed
    const runtimePool = makeMockPool([
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
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
      { rows: [{ region: REGION }] },
      { rows: [] },
      { rows: [] },
      { rows: [], rowCount: 1 },
    ]);

    // controlDb is now barely used (only as the first arg to getRuntimeDbForApp,
    // which we mock); an empty pool is fine.
    const controlDb = makeMockPool();

    const dataPlaneDb = makeMockPool();
    (getRuntimeDbPool as any).mockReturnValue(runtimePool);
    runtimePoolHolder.value = runtimePool;

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
    // runtimePool.query sequence (same call sites as above, but the region
    // lookup returns no rows, so executeProvision throws and the worker
    // logs + writes a retry update instead of mark-completed):
    //   1. recoverStaleTasks: reset
    //   2. recoverStaleTasks: fail
    //   3. processNextTask: claim task
    //   4. executeProvision: SELECT region → empty → throw
    //   5. retry/backoff UPDATE
    const emptyRuntimePool = makeMockPool([
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
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
      { rows: [] },               // SELECT region → empty
      { rows: [], rowCount: 1 },  // retry/backoff UPDATE
    ]);
    (getRuntimeDbPool as any).mockReturnValue(emptyRuntimePool);
    runtimePoolHolder.value = emptyRuntimePool;

    const controlDb = makeMockPool();

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
