import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const provisionNeonDbForApp = vi.fn();
const runtimeQuery = vi.fn().mockResolvedValue({ rows: [] });

vi.mock('./app-db-provision.js', () => ({
  provisionNeonDbForApp: (...args: unknown[]) => provisionNeonDbForApp(...args),
}));

vi.mock('./runtime-db.js', () => ({
  getRuntimeDbPool: () => ({ query: runtimeQuery }),
}));

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  // The tenant branch runs before any region/env lookup; stubbing the assert
  // keeps the test from needing NEON_RUNTIME_PROJECT_ID_* env vars.
  return { ...actual, assertRuntimeDbConfig: () => {} };
});

const { provisionAppDb } = await import('./provisioner.js');
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
    expect(sql).toContain('INSERT INTO app_db_connections');
    expect(sql).toContain('ON CONFLICT (app_id) DO UPDATE');
    expect(params).toEqual([
      APP_ID,
      'postgres://u:p@direct/db_app',
      'postgres://u:p@pooler/db_app',
      'tenant-proj-1',
      `db_${APP_ID}`,
    ]);
  });
});
