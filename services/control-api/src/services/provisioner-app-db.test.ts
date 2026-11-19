import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const localQuery = vi.fn();
const localEnd = vi.fn();
const localPool = vi.fn(() => ({ query: localQuery, end: localEnd }));
vi.mock('pg', async (importOriginal) => {
  const actual = await importOriginal<typeof import('pg')>();
  return { ...actual, default: { ...actual.default, Pool: localPool } };
});

const provisionNeonDbForApp = vi.fn();
const runtimeQuery = vi.fn().mockResolvedValue({ rows: [] });

vi.mock('./app-db-provision.js', () => ({
  provisionNeonDbForApp: (...args: unknown[]) => provisionNeonDbForApp(...args),
}));

// Captures its arguments: step-restore-data reads app_db_connections from the
// DEST region's runtime DB, so writing it to the wrong region's pool would be
// silently invisible to a mock that ignored them.
const getRuntimeDbPool = vi.fn(() => ({ query: runtimeQuery }));

vi.mock('./runtime-db.js', () => ({
  getRuntimeDbPool: (...args: unknown[]) => getRuntimeDbPool(...(args as [])),
}));

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  // The tenant branch runs before any region/env lookup; stubbing the assert
  // keeps the test from needing NEON_RUNTIME_PROJECT_ID_* env vars.
  return { ...actual, assertRuntimeDbConfig: () => {} };
});

// Spread the real module so the genuine `isProjectPerTenantForRegion` runs
// (and so a future export can't break this partial factory); only the
// shared-project lookup is stubbed, to avoid needing NEON_DATA_PROJECT_ID_*.
vi.mock('./neon-projects.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./neon-projects.js')>();
  return { ...actual, getDataProjectIdForRegion: vi.fn(() => 'legacy-shared-proj-1') };
});

vi.mock('./neon-client.js', () => ({
  withNeonProjectLock: async (_projectId: string, fn: () => Promise<void>) => fn(),
  ensureRoleExists: vi.fn().mockResolvedValue(undefined),
  createDatabase: vi.fn().mockResolvedValue(undefined),
  grantSchemaPrivileges: vi.fn().mockResolvedValue(undefined),
  getConnectionString: vi.fn().mockResolvedValue({
    connectionUri: 'postgres://u:p@direct/legacy-db',
    poolerHost: undefined,
    pooledConnectionUri: undefined,
  }),
}));

const { provisionAppDb, custDbNameFor } = await import('./provisioner.js');
const { config } = await import('../config.js');

const APP_ID = 'app_k3f9x2m1qp0z';
const REGION = 'us-west-2';

describe('provisionAppDb — tenant branch (projectPerTenant = true)', () => {
  const original = config.neon.projectPerTenant;

  beforeEach(() => {
    config.neon.projectPerTenant = true;
    provisionNeonDbForApp.mockReset().mockResolvedValue({
      connectionUri: 'postgres://u:p@direct/db_app',
      poolerConnectionString: 'postgres://u:p@pooler/db_app',
      neonProjectId: 'tenant-proj-1',
      neonDatabaseName: `db_${APP_ID}`,
    });
    runtimeQuery.mockClear();
    getRuntimeDbPool.mockClear();
  });

  afterEach(() => { config.neon.projectPerTenant = original; });

  it('delegates to provisionNeonDbForApp rather than creating a cust_* database', async () => {
    const out = await provisionAppDb(REGION, APP_ID, 'owner');

    expect(provisionNeonDbForApp).toHaveBeenCalledWith(REGION, APP_ID);
    expect(out.neonDbName).toBe(`db_${APP_ID}`);
    expect(out.neonDbName).not.toMatch(/^cust_/);
    expect(out.connectionUri).toBe('postgres://u:p@direct/db_app');
  });

  it('still writes the app_db_connections row step-restore-data depends on', async () => {
    await provisionAppDb(REGION, APP_ID, 'owner');

    expect(runtimeQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = runtimeQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('ON CONFLICT (app_id) DO UPDATE');

    // Column list and placeholder list asserted together, so a reordered
    // column list no longer matches even though `params` order would.
    const columns = /INSERT INTO app_db_connections\s*\(([^)]*)\)/
      .exec(sql)?.[1]
      .split(',')
      .map((c) => c.trim());
    const placeholders = /VALUES\s*\(([^)]*)\)/
      .exec(sql)?.[1]
      .split(',')
      .map((p) => p.trim());
    expect(columns).toEqual([
      'app_id',
      'connection_string',
      'pooler_connection_string',
      'neon_project_id',
      'neon_database_name',
    ]);
    expect(placeholders).toEqual(['$1', '$2', '$3', '$4', '$5']);

    // Column -> value correspondence, keyed by name rather than position.
    const byColumn = Object.fromEntries(
      columns!.map((c, i) => [c, params[Number(placeholders![i].slice(1)) - 1]]),
    );
    expect(byColumn).toEqual({
      app_id: APP_ID,
      connection_string: 'postgres://u:p@direct/db_app',
      pooler_connection_string: 'postgres://u:p@pooler/db_app',
      neon_project_id: 'tenant-proj-1',
      neon_database_name: `db_${APP_ID}`,
    });
  });

  it('writes app_db_connections to the requested region’s runtime pool', async () => {
    await provisionAppDb(REGION, APP_ID, 'owner');

    expect(getRuntimeDbPool).toHaveBeenCalledWith(expect.anything(), REGION);
  });
});

describe('provisionAppDb — legacy branch (projectPerTenant = false)', () => {
  const original = config.neon.projectPerTenant;

  beforeEach(() => {
    config.neon.projectPerTenant = false;
    runtimeQuery.mockClear();
    getRuntimeDbPool.mockClear();
  });

  afterEach(() => { config.neon.projectPerTenant = original; });

  // Regression guard for the reconciler's orphan detection: the reconciler
  // decides which cust_* databases are live by recomputing this same name
  // via the shared `custDbNameFor` export. If provisionAppDb's actual
  // database name ever drifts from `custDbNameFor`'s output — e.g. someone
  // reintroduces a second inline copy of the naming instead of calling the
  // shared helper — every live cust_* database becomes a false orphan and
  // gets deleted. This test calls the real `provisionAppDb` legacy path
  // (not just the helper in isolation) and asserts the two stay identical.
  it('names the cust_* database exactly as custDbNameFor computes it', async () => {
    const out = await provisionAppDb(REGION, APP_ID, 'owner');

    expect(out.neonDbName).toBe(custDbNameFor(APP_ID, REGION));
    expect(out.neonDbName).toBe('cust_app_k3f9x2m1qp0z_us_west_2');
  });
});

describe('provisionAppDb — per-region override', () => {
  const original = config.neon.projectPerTenant;

  beforeEach(() => {
    provisionNeonDbForApp.mockReset().mockResolvedValue({
      connectionUri: 'postgres://u:p@direct/db_app',
      poolerConnectionString: null,
      neonProjectId: 'tenant-proj-1',
      neonDatabaseName: `db_${APP_ID}`,
    });
    runtimeQuery.mockClear();
    getRuntimeDbPool.mockClear();
  });

  afterEach(() => {
    config.neon.projectPerTenant = original;
    delete process.env.BUTTERBASE_PROJECT_PER_TENANT_US_WEST_2;
  });

  it('takes the tenant branch when only the region is enabled', async () => {
    config.neon.projectPerTenant = false;
    process.env.BUTTERBASE_PROJECT_PER_TENANT_US_WEST_2 = 'true';

    const out = await provisionAppDb(REGION, APP_ID, 'owner');

    expect(provisionNeonDbForApp).toHaveBeenCalledWith(REGION, APP_ID);
    expect(out.neonDbName).toBe(`db_${APP_ID}`);
  });

  it('takes the legacy branch when the region is disabled despite a true global', async () => {
    config.neon.projectPerTenant = true;
    process.env.BUTTERBASE_PROJECT_PER_TENANT_US_WEST_2 = 'false';

    const out = await provisionAppDb(REGION, APP_ID, 'owner');

    expect(provisionNeonDbForApp).not.toHaveBeenCalled();
    expect(out.neonDbName).toBe(custDbNameFor(APP_ID, REGION));
  });
});

// Dummy connection details, never a live database or Neon account.
describe('provisionAppDb — explicit local mode (#42)', () => {
  const adminUrl = 'postgresql://local_user:local_password@localhost:5542/postgres';

  beforeEach(() => {
    vi.stubEnv('BUTTERBASE_LOCAL', 'true');
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('LOCAL_DATA_PLANE_URL_US_WEST_2', adminUrl);
    localQuery.mockReset().mockResolvedValue({ rows: [] });
    localEnd.mockReset().mockResolvedValue(undefined);
    localPool.mockClear();
    runtimeQuery.mockClear();
    getRuntimeDbPool.mockClear();
    provisionNeonDbForApp.mockClear();
  });

  afterEach(() => { vi.unstubAllEnvs(); });

  it('creates a real local destination and registers the URI used by restore', async () => {
    const out = await provisionAppDb(REGION, APP_ID, 'owner');
    const name = custDbNameFor(APP_ID, REGION);
    expect(out).toEqual({ neonDbName: name, connectionUri: adminUrl.replace('/postgres', '/' + name) });
    expect(localPool).toHaveBeenCalledWith(expect.objectContaining({ connectionString: adminUrl }));
    expect(localQuery).toHaveBeenCalledWith('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    expect(localQuery).toHaveBeenCalledWith(`CREATE DATABASE "${name}"`);
    expect(localEnd).toHaveBeenCalledOnce();
    expect(getRuntimeDbPool).toHaveBeenCalledWith(expect.anything(), REGION);
    expect(runtimeQuery).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO app_db_connections'), [APP_ID, out.connectionUri, null, null, name]);
    expect(provisionNeonDbForApp).not.toHaveBeenCalled();
  });

  it('removes libpq database overrides from the destination URI', async () => {
    vi.stubEnv('LOCAL_DATA_PLANE_URL_US_WEST_2', adminUrl + '?dbname=postgres&application_name=move-smoke');
    const out = await provisionAppDb(REGION, APP_ID, 'owner');
    expect(new URL(out.connectionUri).searchParams.has('dbname')).toBe(false);
    expect(new URL(out.connectionUri).searchParams.get('application_name')).toBe('move-smoke');
  });

  it('adopts an existing destination on retry', async () => {
    localQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    await provisionAppDb(REGION, APP_ID, 'owner');
    expect(localQuery).toHaveBeenCalledTimes(1);
    expect(runtimeQuery).toHaveBeenCalledOnce();
  });

  it('tolerates a concurrent CREATE DATABASE winning the race', async () => {
    localQuery.mockResolvedValueOnce({ rows: [] }).mockRejectedValueOnce(Object.assign(new Error('duplicate_database'), { code: '42P04' }));
    await expect(provisionAppDb(REGION, APP_ID, 'owner')).resolves.toHaveProperty('neonDbName');
    expect(localEnd).toHaveBeenCalledOnce();
  });

  it('closes the admin pool and leaves no connection row on failure', async () => {
    localQuery.mockRejectedValueOnce(new Error('local database unavailable'));
    await expect(provisionAppDb(REGION, APP_ID, 'owner')).rejects.toThrow('local database unavailable');
    expect(localEnd).toHaveBeenCalledOnce();
    expect(runtimeQuery).not.toHaveBeenCalled();
  });

  it('refuses local mode in production before touching Postgres', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    await expect(provisionAppDb(REGION, APP_ID, 'owner')).rejects.toThrow(/BUTTERBASE_LOCAL.*production/);
    expect(localPool).not.toHaveBeenCalled();
    expect(runtimeQuery).not.toHaveBeenCalled();
  });

  it('requires an explicit data-plane URL for the destination region', async () => {
    vi.stubEnv('LOCAL_DATA_PLANE_URL_US_WEST_2', '');
    await expect(provisionAppDb(REGION, APP_ID, 'owner')).rejects.toThrow(/LOCAL_DATA_PLANE_URL_US_WEST_2/);
    expect(localPool).not.toHaveBeenCalled();
  });

  it('rejects a non-Postgres URL without disclosing its contents', async () => {
    vi.stubEnv('LOCAL_DATA_PLANE_URL_US_WEST_2', 'https://dummy-secret.invalid');
    await expect(provisionAppDb(REGION, APP_ID, 'owner')).rejects.toThrow('must be a PostgreSQL connection URL');
    expect(localPool).not.toHaveBeenCalled();
  });

  it('takes the existing Neon path unless local mode is exactly true', async () => {
    vi.stubEnv('BUTTERBASE_LOCAL', 'false');
    const original = config.neon.projectPerTenant;
    config.neon.projectPerTenant = false;
    try {
      await expect(provisionAppDb(REGION, APP_ID, 'owner')).resolves.toHaveProperty('neonDbName', custDbNameFor(APP_ID, REGION));
      expect(localPool).not.toHaveBeenCalled();
    } finally { config.neon.projectPerTenant = original; }
  });
});
