import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../plugins/rate-limit.js', () => ({ rateLimitAllowList: () => true }));

vi.mock('../services/region-resolver.js', () => ({
  resolveAppHomeRegion: vi.fn().mockResolvedValue('us-east-1'),
  getConfiguredRuntimeRegions: vi.fn(() => ['us-east-1']),
  fanOutRuntimeRegions: vi.fn(),
}));

vi.mock('../config.js', () => ({ config: { runtimeDb: {} } }));

vi.mock('../services/runtime-db.js', () => ({ getRuntimeDbPool: vi.fn() }));
vi.mock('../services/app-pool.js', () => ({ getAppPoolForApp: vi.fn() }));
vi.mock('../services/schema-introspector.js', () => ({ introspectSchema: vi.fn() }));

import Fastify from 'fastify';
import { templatesDiscoveryRoutes } from './templates-discovery.js';
import { getRuntimeDbPool } from '../services/runtime-db.js';
import { getAppPoolForApp } from '../services/app-pool.js';
import { introspectSchema } from '../services/schema-introspector.js';

const APP_ID = 'app_template1';

// The regional runtime DB. Holds platform tables (apps, app_plans, usage_meters…)
// and per-app function metadata. It is NOT where an app's user tables live.
const runtimePool = { __which: 'runtime' } as any;
// The app's own Neon database. This is where its user tables live.
const appPool = { __which: 'app' } as any;

function buildRuntimeQuery() {
  return vi.fn(async (sql: string) => {
    if (/FROM apps WHERE id/.test(sql)) {
      return {
        rows: [{
          id: APP_ID,
          name: 'butterbase-crm',
          owner_id: 'owner-1',
          created_at: new Date('2026-06-02T07:01:09.328Z'),
          fork_count: 33,
          repo_latest_snapshot: 'snap_1',
          visibility: 'public',
          listed: true,
          db_name: 'db_template1',
        }],
      };
    }
    if (/FROM app_functions/.test(sql)) {
      return { rows: [{ name: 'agent-chat', trigger_type: 'http' }] };
    }
    // Fork sample fan-out and owner-name lookups.
    return { rows: [] };
  });
}

async function buildServer() {
  const app = Fastify();
  (app as any).controlDb = { query: vi.fn(async () => ({ rows: [] })) };
  await app.register(templatesDiscoveryRoutes);
  await app.ready();
  return app;
}

describe('GET /v1/templates/:app_id — schema introspection target', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtimePool.query = buildRuntimeQuery();
    appPool.query = vi.fn(async () => ({ rows: [] }));
    (getRuntimeDbPool as any).mockReturnValue(runtimePool);
    (getAppPoolForApp as any).mockResolvedValue(appPool);
    (introspectSchema as any).mockResolvedValue({
      tables: {
        contacts: { columns: { id: { type: 'uuid' }, email: { type: 'text' } } },
        companies: { columns: { id: { type: 'uuid' } } },
      },
    });
  });

  it("introspects the app's own database, not the regional runtime database", async () => {
    const app = await buildServer();
    const res = await app.inject({ method: 'GET', url: `/v1/templates/${APP_ID}` });
    expect(res.statusCode).toBe(200);

    expect(introspectSchema).toHaveBeenCalledTimes(1);
    const poolUsed = (introspectSchema as any).mock.calls[0][0];
    expect(poolUsed).toBe(appPool);
    expect(poolUsed).not.toBe(runtimePool);

    await app.close();
  });

  it('resolves the app pool using the app id and its db_name', async () => {
    const app = await buildServer();
    await app.inject({ method: 'GET', url: `/v1/templates/${APP_ID}` });

    expect(getAppPoolForApp).toHaveBeenCalledWith(
      expect.anything(),
      APP_ID,
      'db_template1',
    );

    await app.close();
  });

  it("returns the app's user tables", async () => {
    const app = await buildServer();
    const res = await app.inject({ method: 'GET', url: `/v1/templates/${APP_ID}` });
    const body = res.json();

    expect(body.tables).toEqual([
      { name: 'contacts', column_count: 2 },
      { name: 'companies', column_count: 1 },
    ]);
    expect(body.schema_summary.table_count).toBe(2);

    await app.close();
  });

  it('degrades to empty tables when the app database is unreachable', async () => {
    (getAppPoolForApp as any).mockRejectedValue(new Error('ECONNREFUSED'));

    const app = await buildServer();
    const res = await app.inject({ method: 'GET', url: `/v1/templates/${APP_ID}` });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tables).toEqual([]);
    expect(body.functions).toHaveLength(1);

    await app.close();
  });
});
