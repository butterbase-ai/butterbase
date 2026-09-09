/**
 * executeResetTask (neon-task-worker.ts) is the wrapper that resolves the
 * PRODUCTION and STAGING per-app pools and hands them to executeStagingReset.
 * That assignment — `const prodPool = await getAppPoolForApp(controlDb,
 * prodAppId, ...)` / `const stagingPool = await getAppPoolForApp(controlDb,
 * stagingAppId, ...)` — is the single most dangerous line in this feature: if
 * the two right-hand sides were ever swapped, every guard that compares
 * VALUES chosen upstream of this call (ids, object identity) would still
 * pass, because both ids would still differ and the two pool objects would
 * still be distinct — they would just be pointed at the wrong apps.
 *
 * executeStagingReset's own unit tests (staging-reset.test.ts) inject
 * prodPool/stagingPool directly and can never see this wrapper get it wrong.
 * This file exists to close exactly that gap: it drives the real
 * executeResetTask, with getAppPoolForApp mocked to return a pool object
 * TAGGED with the appId/dbName it was actually resolved for, and asserts
 * executeStagingReset receives deps.prodPool tagged 'app_prod' and
 * deps.stagingPool tagged 'app_staging'. If neon-task-worker.ts's two
 * assignments were ever swapped, this test fails.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getEnvironmentLink: vi.fn(),
  getAppPoolForApp: vi.fn(),
  executeStagingReset: vi.fn(),
}));

vi.mock('../runtime-db.js', () => ({
  getRuntimeDbPool: () => ({
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('SELECT db_name FROM apps WHERE id = $1')) {
        const id = params[0];
        if (id === 'app_prod') return { rows: [{ db_name: 'db_prod' }] };
        if (id === 'app_staging') return { rows: [{ db_name: 'db_staging' }] };
        return { rows: [] };
      }
      return { rows: [] };
    }),
  }),
}));

vi.mock('../region-resolver.js', async (orig) => ({
  ...(await orig<typeof import('../region-resolver.js')>()),
  getRuntimeDbForApp: vi.fn(async () => ({ query: vi.fn().mockResolvedValue({ rows: [] }) })),
}));

vi.mock('../app-environments.js', () => ({
  getEnvironmentLink: mocks.getEnvironmentLink,
}));

vi.mock('../app-pool.js', () => ({
  getAppPoolForApp: mocks.getAppPoolForApp,
}));

vi.mock('../staging-reset.js', () => ({
  executeStagingReset: mocks.executeStagingReset,
}));

import { executeResetTask } from '../neon-task-worker.js';

const job = {
  id: 'cj_reset_1',
  mode: 'staging_reset',
  status: 'pending',
  source_app_id: 'app_prod',
  dest_app_id: 'app_staging',
  dest_region: 'us-east-1',
};

/** Fake control-plane pool: getCloneJob/setCloneJobStatus read/write this. */
const controlDb = {
  query: vi.fn(async (sql: string) => {
    if (sql.includes('SELECT * FROM template_clone_jobs')) return { rows: [job] };
    return { rows: [] };
  }),
} as never;

const task = {
  id: 1, app_id: 'app_prod', task_type: 'clone' as const, status: 'processing',
  attempts: 1, max_attempts: 3, last_error: null, locked_at: null,
  run_after: new Date(), created_at: new Date(),
  task_meta: { job_id: 'cj_reset_1' },
};

const silentLogger = { info() {}, warn() {}, error() {} };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getEnvironmentLink.mockResolvedValue({ staging_app_id: 'app_staging' });
  mocks.executeStagingReset.mockResolvedValue(undefined);
  // Tagged so a test can prove WHICH app/db each resolved pool actually
  // points at, independent of object identity or id comparisons.
  mocks.getAppPoolForApp.mockImplementation(
    async (_controlDb: unknown, appId: string, dbName: string) => ({
      __appId: appId, __dbName: dbName, query: vi.fn().mockResolvedValue({ rows: [] }),
    }),
  );
});

describe('executeResetTask', () => {
  it('resolves prodPool for the PRODUCTION app and stagingPool for the STAGING app — never swapped', async () => {
    await executeResetTask(controlDb, task, silentLogger);

    expect(mocks.executeStagingReset).toHaveBeenCalledTimes(1);
    const [deps] = mocks.executeStagingReset.mock.calls[0];

    // This is the assertion that fails if neon-task-worker.ts's two
    // `getAppPoolForApp` assignments are ever swapped: a swap would make
    // deps.prodPool carry appId 'app_staging' / dbName 'db_staging' instead.
    expect(deps.prodPool.__appId).toBe('app_prod');
    expect(deps.prodPool.__dbName).toBe('db_prod');
    expect(deps.stagingPool.__appId).toBe('app_staging');
    expect(deps.stagingPool.__dbName).toBe('db_staging');

    // Belt-and-suspenders on the same fact, phrased as negatives so a
    // reader can see at a glance what "swapped" would have looked like.
    expect(deps.prodPool.__appId).not.toBe('app_staging');
    expect(deps.stagingPool.__appId).not.toBe('app_prod');
  });

  it('passes the resolved staging db_name through as stagingDbName', async () => {
    await executeResetTask(controlDb, task, silentLogger);
    const [deps] = mocks.executeStagingReset.mock.calls[0];
    expect(deps.stagingDbName).toBe('db_staging');
  });

  it('calls getAppPoolForApp with the production id/db_name for the prod resolution', async () => {
    await executeResetTask(controlDb, task, silentLogger);
    expect(mocks.getAppPoolForApp).toHaveBeenCalledWith(controlDb, 'app_prod', 'db_prod');
    expect(mocks.getAppPoolForApp).toHaveBeenCalledWith(controlDb, 'app_staging', 'db_staging');
  });

  it('refuses when the environment link no longer points at this staging app', async () => {
    mocks.getEnvironmentLink.mockResolvedValue({ staging_app_id: 'app_other_staging' });
    await expect(executeResetTask(controlDb, task, silentLogger)).rejects.toThrow(
      /no longer linked/i,
    );
    expect(mocks.executeStagingReset).not.toHaveBeenCalled();
  });
});
