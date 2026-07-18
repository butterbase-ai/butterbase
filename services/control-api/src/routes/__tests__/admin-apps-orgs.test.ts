import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import fp from 'fastify-plugin';

// Mock admin-auth so requireAdmin is controllable (same pattern as
// src/routes/admin/__tests__/activity.test.ts).
vi.mock('../admin-auth.js', () => ({
  requireAdmin: vi.fn(),
}));

// Mock region-resolver so tests don't need real runtime pools.
vi.mock('../../services/region-resolver.js', () => ({
  fanOutQuery: vi.fn(),
  fanOutRuntimeRegions: vi.fn(),
  getRuntimeDbForApp: vi.fn(),
}));

import { requireAdmin } from '../admin-auth.js';
import { fanOutRuntimeRegions, getRuntimeDbForApp } from '../../services/region-resolver.js';
import { adminRoutes } from '../admin.js';
import organizationsRoutes from '../admin/organizations.js';

const mockRequireAdmin = vi.mocked(requireAdmin);
const mockFanOutRuntimeRegions = vi.mocked(fanOutRuntimeRegions);
const mockGetRuntimeDbForApp = vi.mocked(getRuntimeDbForApp);

function makeControlDbMock(handlers: (sql: string, params: unknown[]) => { rows: any[] } | null) {
  return {
    query: vi.fn().mockImplementation(async (sql: string, params: unknown[]) => {
      const r = handlers(sql, params);
      return r ?? { rows: [] };
    }),
  };
}

async function makeApp(controlDb: any) {
  const app = Fastify({ logger: false });
  await app.register(
    fp(
      async (i: any) => {
        i.decorate('controlDb', controlDb);
      },
      { name: 'shim' }
    )
  );
  await app.register(adminRoutes);
  return app;
}

// Registers both adminRoutes (the shim under test) and organizationsRoutes
// (the real forward target) on one Fastify instance so app.inject inside the
// shim can actually reach PATCH /admin/organizations/:id/plan — mirroring
// how both plugins share one root app in production (src/index.ts).
// organizationsRoutes uses lib/admin-guard.js's requireAdmin, which is NOT
// mocked here (only ../admin-auth.js is), so controlDb must additionally
// answer the `FROM platform_users WHERE cognito_sub = $1` admin-check query
// and authProvider must be decorated.
async function makeAppWithOrgForwarding(controlDb: any, isAdmin = true) {
  const app = Fastify({ logger: false });
  await app.register(
    fp(
      async (i: any) => {
        const original = controlDb.query;
        controlDb.query = vi.fn().mockImplementation(async (sql: string, params: unknown[]) => {
          if (sql.includes('FROM platform_users') && sql.includes('cognito_sub')) {
            return { rows: [{ id: 'admin-uid', email: 'admin@example.com', display_name: null, is_admin: isAdmin }] };
          }
          return original(sql, params);
        });
        i.decorate('controlDb', controlDb);
        i.decorate('authProvider', { async verifyJwt() { return { sub: 'sub-1' }; } });
      },
      { name: 'shim' }
    )
  );
  await app.register(adminRoutes);
  await app.register(organizationsRoutes);
  return app;
}

/**
 * Drives the callback passed to `fanOutRuntimeRegions(async pool => {...})`
 * against a fake pool, recording every query issued so tests can assert on
 * the SQL/params, and returns the merged single-region shape the real
 * helper would produce.
 */
function makeFanOutRuntimeRegionsMock(
  dataRows: any[],
  total: number,
  capturedQueries: { sql: string; params: unknown[] }[] = []
) {
  return vi.fn().mockImplementation(async (cb: any) => {
    const poolStub = {
      query: vi.fn().mockImplementation(async (sql: string, params: unknown[]) => {
        capturedQueries.push({ sql, params });
        if (sql.includes('count(*)::int AS total')) {
          return { rows: [{ total }] };
        }
        return { rows: dataRows };
      }),
    };
    const result = await cb(poolStub);
    return [{ region: 'us-east-1', result }];
  });
}

const teamApp = {
  id: 'app-team-1',
  name: 'Team App',
  region: 'us-east-1',
  db_provisioned: true,
  deployment_url: 'https://team.example.com',
  last_deployed_at: '2026-01-04T00:00:00Z',
  created_at: '2026-01-01T00:00:00Z',
  owner_id: 'owner-1',
  function_count: 0,
};

const personalApp = {
  id: 'app-personal-1',
  name: 'Personal App',
  region: 'us-east-1',
  db_provisioned: true,
  deployment_url: 'https://personal.example.com',
  last_deployed_at: '2026-01-04T00:00:00Z',
  created_at: '2026-01-02T00:00:00Z',
  owner_id: 'owner-1',
  function_count: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAdmin.mockResolvedValue('admin-uid');
});

describe('GET /admin/apps org enrichment', () => {
  it('list rows carry organization_id/name/personal', async () => {
    mockFanOutRuntimeRegions.mockImplementation(
      makeFanOutRuntimeRegionsMock([teamApp, personalApp], 2)
    );
    const controlDb = makeControlDbMock((sql) => {
      if (sql.includes('FROM org_app_index oai') && sql.includes('JOIN organizations o')) {
        return {
          rows: [
            { app_id: 'app-team-1', organization_id: 'org-team', organization_name: 'Acme', organization_personal: false },
            { app_id: 'app-personal-1', organization_id: 'org-personal', organization_name: 'Personal', organization_personal: true },
          ],
        };
      }
      if (sql.includes('FROM platform_users WHERE id = ANY')) {
        return { rows: [{ id: 'owner-1', email: 'owner@example.com' }] };
      }
      return null;
    });
    const app = await makeApp(controlDb);
    const r = await app.inject({ method: 'GET', url: '/admin/apps', headers: { authorization: 'Bearer ok' } });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    const team = body.data.find((row: any) => row.id === 'app-team-1');
    const personal = body.data.find((row: any) => row.id === 'app-personal-1');
    expect(team.organization_id).toBe('org-team');
    expect(team.organization_name).toBe('Acme');
    expect(team.organization_personal).toBe(false);
    expect(personal.organization_id).toBe('org-personal');
    expect(personal.organization_personal).toBe(true);
    expect(body.total).toBe(2);
  });

  it('organization_id filter pre-resolves app ids in controlDb and constrains the runtime fanout', async () => {
    const capturedQueries: { sql: string; params: unknown[] }[] = [];
    mockFanOutRuntimeRegions.mockImplementation(makeFanOutRuntimeRegionsMock([teamApp], 1, capturedQueries));
    const controlDb = makeControlDbMock((sql, params) => {
      if (sql.includes('FROM org_app_index WHERE organization_id = $1')) {
        expect(params).toEqual(['org-team']);
        return { rows: [{ app_id: 'app-team-1' }] };
      }
      if (sql.includes('FROM org_app_index oai') && sql.includes('JOIN organizations o')) {
        return {
          rows: [
            { app_id: 'app-team-1', organization_id: 'org-team', organization_name: 'Acme', organization_personal: false },
          ],
        };
      }
      if (sql.includes('FROM platform_users WHERE id = ANY')) {
        return { rows: [{ id: 'owner-1', email: 'owner@example.com' }] };
      }
      return null;
    });
    const app = await makeApp(controlDb);
    const r = await app.inject({
      method: 'GET',
      url: '/admin/apps?organization_id=org-team',
      headers: { authorization: 'Bearer ok' },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].organization_id).toBe('org-team');

    // The runtime fanout's data query must have been constrained with
    // `a.id = ANY($n::uuid[])` bound to the controlDb-resolved app id list.
    const dataQuery = capturedQueries.find((q) => q.sql.includes('LEFT JOIN LATERAL'));
    expect(dataQuery).toBeDefined();
    expect(dataQuery!.sql).toContain('a.id = ANY(');
    expect(dataQuery!.params[0]).toEqual(['app-team-1']);
  });

  it('unknown organization_id returns empty result without calling the runtime fanout', async () => {
    const controlDb = makeControlDbMock((sql) => {
      if (sql.includes('FROM org_app_index WHERE organization_id = $1')) {
        return { rows: [] };
      }
      return null;
    });
    const app = await makeApp(controlDb);
    const r = await app.inject({
      method: 'GET',
      url: '/admin/apps?organization_id=org-unknown',
      headers: { authorization: 'Bearer ok' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ data: [], total: 0 });
    expect(mockFanOutRuntimeRegions).not.toHaveBeenCalled();
  });

  it('personal_only=yes filters to organization_personal === true', async () => {
    mockFanOutRuntimeRegions.mockImplementation(
      makeFanOutRuntimeRegionsMock([teamApp, personalApp], 2)
    );
    const controlDb = makeControlDbMock((sql) => {
      if (sql.includes('FROM org_app_index oai') && sql.includes('JOIN organizations o')) {
        return {
          rows: [
            { app_id: 'app-team-1', organization_id: 'org-team', organization_name: 'Acme', organization_personal: false },
            { app_id: 'app-personal-1', organization_id: 'org-personal', organization_name: 'Personal', organization_personal: true },
          ],
        };
      }
      if (sql.includes('FROM platform_users WHERE id = ANY')) {
        return { rows: [{ id: 'owner-1', email: 'owner@example.com' }] };
      }
      return null;
    });
    const app = await makeApp(controlDb);
    const r = await app.inject({
      method: 'GET',
      url: '/admin/apps?personal_only=yes',
      headers: { authorization: 'Bearer ok' },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe('app-personal-1');
    expect(body.data.every((row: any) => row.organization_personal === true)).toBe(true);
    expect(body.total).toBe(1);
  });

  it('personal_only=no filters to organization_personal === false', async () => {
    mockFanOutRuntimeRegions.mockImplementation(
      makeFanOutRuntimeRegionsMock([teamApp, personalApp], 2)
    );
    const controlDb = makeControlDbMock((sql) => {
      if (sql.includes('FROM org_app_index oai') && sql.includes('JOIN organizations o')) {
        return {
          rows: [
            { app_id: 'app-team-1', organization_id: 'org-team', organization_name: 'Acme', organization_personal: false },
            { app_id: 'app-personal-1', organization_id: 'org-personal', organization_name: 'Personal', organization_personal: true },
          ],
        };
      }
      if (sql.includes('FROM platform_users WHERE id = ANY')) {
        return { rows: [{ id: 'owner-1', email: 'owner@example.com' }] };
      }
      return null;
    });
    const app = await makeApp(controlDb);
    const r = await app.inject({
      method: 'GET',
      url: '/admin/apps?personal_only=no',
      headers: { authorization: 'Bearer ok' },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe('app-team-1');
    expect(body.data.every((row: any) => row.organization_personal === false)).toBe(true);
    expect(body.total).toBe(1);
  });
});

describe('GET /admin/apps/:id org enrichment', () => {
  it('the returned app object has organization_id/name/personal', async () => {
    const runtimePoolStub = {
      query: vi.fn().mockImplementation(async (sql: string) => {
        if (sql.includes('FROM apps a')) {
          return { rows: [teamApp] };
        }
        if (sql.includes('FROM app_functions f')) {
          return { rows: [] };
        }
        if (sql.includes('FROM function_invocations fi')) {
          return { rows: [] };
        }
        if (sql.includes('FROM ai_usage_logs')) {
          return { rows: [] };
        }
        return { rows: [] };
      }),
    };
    mockGetRuntimeDbForApp.mockResolvedValue(runtimePoolStub as any);

    const controlDb = makeControlDbMock((sql, params) => {
      if (sql.includes('FROM audit_events')) {
        return { rows: [] };
      }
      if (sql.includes('FROM platform_users WHERE id = $1')) {
        return { rows: [{ id: 'owner-1', email: 'owner@example.com' }] };
      }
      if (sql.includes('FROM org_app_index oai') && sql.includes('WHERE oai.app_id = $1')) {
        expect(params).toEqual(['app-team-1']);
        return {
          rows: [
            { organization_id: 'org-team', organization_name: 'Acme', organization_personal: false },
          ],
        };
      }
      return null;
    });

    const app = await makeApp(controlDb);
    const r = await app.inject({
      method: 'GET',
      url: '/admin/apps/app-team-1',
      headers: { authorization: 'Bearer ok' },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.app.organization_id).toBe('org-team');
    expect(body.app.organization_name).toBe('Acme');
    expect(body.app.organization_personal).toBe(false);
  });
});

describe('POST /admin/apps/:id/transfer', () => {
  it('200 transfers app between orgs and emits audit event', async () => {
    const updateCalls: any[] = [];
    const insertCalls: any[] = [];

    const controlDb = makeControlDbMock((sql, params) => {
      if (sql.includes('UPDATE org_app_index SET organization_id')) {
        updateCalls.push({ sql, params });
        return { rows: [{ command: 'UPDATE', rowCount: 1 }] };
      }
      if (sql.includes('INSERT INTO billing_events')) {
        insertCalls.push({ sql, params });
        return { rows: [{ command: 'INSERT' }] };
      }
      if (sql.includes('SELECT organization_id FROM org_app_index WHERE app_id = $1')) {
        expect(params).toEqual(['app-team-1']);
        return { rows: [{ organization_id: 'org-team' }] };
      }
      if (sql.includes('FROM organizations WHERE id = $1')) {
        expect(params[0]).toEqual('org-dest');
        return { rows: [{ id: 'org-dest', personal: false }] };
      }
      return null;
    });

    const app = await makeApp(controlDb);
    const r = await app.inject({
      method: 'POST',
      url: '/admin/apps/app-team-1/transfer',
      headers: { authorization: 'Bearer ok' },
      payload: { destination_organization_id: 'org-dest' },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.app_id).toBe('app-team-1');
    expect(body.from_organization_id).toBe('org-team');
    expect(body.to_organization_id).toBe('org-dest');

    // Verify UPDATE was called with correct params
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].params).toEqual(['org-dest', 'app-team-1']);

    // Verify INSERT billing_events was called
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0].params[0]).toBe('org-dest');
    expect(insertCalls[0].params[1]).toContain('app-team-1');
    expect(insertCalls[0].params[1]).toContain('org-team');
  });

  it('409 when app already in destination org', async () => {
    const controlDb = makeControlDbMock((sql, params) => {
      if (sql.includes('SELECT organization_id FROM org_app_index WHERE app_id = $1')) {
        return { rows: [{ organization_id: 'org-dest' }] };
      }
      return null;
    });

    const app = await makeApp(controlDb);
    const r = await app.inject({
      method: 'POST',
      url: '/admin/apps/app-team-1/transfer',
      headers: { authorization: 'Bearer ok' },
      payload: { destination_organization_id: 'org-dest' },
    });
    expect(r.statusCode).toBe(409);
    const body = r.json();
    expect(body.error).toBe('already_in_destination');
  });

  it('404 when app does not exist in org_app_index', async () => {
    const controlDb = makeControlDbMock((sql, params) => {
      if (sql.includes('SELECT organization_id FROM org_app_index WHERE app_id = $1')) {
        return { rows: [] };
      }
      return null;
    });

    const app = await makeApp(controlDb);
    const r = await app.inject({
      method: 'POST',
      url: '/admin/apps/app-unknown/transfer',
      headers: { authorization: 'Bearer ok' },
      payload: { destination_organization_id: 'org-dest' },
    });
    expect(r.statusCode).toBe(404);
    const body = r.json();
    expect(body.error).toBe('app_not_found');
  });

  it('404 when destination org does not exist', async () => {
    const controlDb = makeControlDbMock((sql, params) => {
      if (sql.includes('SELECT organization_id FROM org_app_index WHERE app_id = $1')) {
        return { rows: [{ organization_id: 'org-team' }] };
      }
      if (sql.includes('FROM organizations WHERE id = $1')) {
        return { rows: [] };
      }
      return null;
    });

    const app = await makeApp(controlDb);
    const r = await app.inject({
      method: 'POST',
      url: '/admin/apps/app-team-1/transfer',
      headers: { authorization: 'Bearer ok' },
      payload: { destination_organization_id: 'org-unknown' },
    });
    expect(r.statusCode).toBe(404);
    const body = r.json();
    expect(body.error).toBe('destination_not_found');
  });

  it('400 when destination is a personal org', async () => {
    const controlDb = makeControlDbMock((sql, params) => {
      if (sql.includes('SELECT organization_id FROM org_app_index WHERE app_id = $1')) {
        return { rows: [{ organization_id: 'org-team' }] };
      }
      if (sql.includes('FROM organizations WHERE id = $1')) {
        return { rows: [{ id: 'org-personal', personal: true }] };
      }
      return null;
    });

    const app = await makeApp(controlDb);
    const r = await app.inject({
      method: 'POST',
      url: '/admin/apps/app-team-1/transfer',
      headers: { authorization: 'Bearer ok' },
      payload: { destination_organization_id: 'org-personal' },
    });
    expect(r.statusCode).toBe(400);
    const body = r.json();
    expect(body.error).toBe('destination_is_personal');
  });

  it('400 when destination_organization_id is missing', async () => {
    const controlDb = makeControlDbMock(() => null);

    const app = await makeApp(controlDb);
    const r = await app.inject({
      method: 'POST',
      url: '/admin/apps/app-team-1/transfer',
      headers: { authorization: 'Bearer ok' },
      payload: {},
    });
    expect(r.statusCode).toBe(400);
    const body = r.json();
    expect(body.error).toBe('destination_organization_id_required');
  });
});

describe('PATCH /admin/billing/users/:id/plan (shim → organizations)', () => {
  it('200 resolves the personal org and forwards; the org handler response is returned intact', async () => {
    const orgPlanUpdateCalls: unknown[][] = [];

    const controlDb = makeControlDbMock((sql, params) => {
      if (sql.includes('SELECT personal_organization_id FROM platform_users WHERE id = $1')) {
        expect(params).toEqual(['user-1']);
        return { rows: [{ personal_organization_id: 'org-personal-1' }] };
      }
      if (sql.includes('SELECT id FROM plans WHERE id = $1')) {
        return { rows: [{ id: 'pro' }] };
      }
      if (sql.includes('UPDATE organizations') && sql.includes('RETURNING')) {
        orgPlanUpdateCalls.push(params);
        return { rows: [{ id: 'org-personal-1', plan_id: 'pro', account_status: 'active' }] };
      }
      if (sql.includes('SELECT') && sql.includes('FROM subscriptions') && sql.includes('WHERE organization_id')) {
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO subscriptions')) {
        return { rows: [{ id: 'sub-1' }] };
      }
      if (sql.includes('INSERT INTO billing_events')) {
        return { rows: [{ id: 'evt-1' }] };
      }
      return null;
    });

    const app = await makeAppWithOrgForwarding(controlDb, true);
    const r = await app.inject({
      method: 'PATCH',
      url: '/admin/billing/users/user-1/plan',
      headers: { authorization: 'Bearer ok' },
      payload: { plan_id: 'pro' },
    });

    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body).toEqual({ organization: { id: 'org-personal-1', plan_id: 'pro', account_status: 'active' } });

    // The forwarded call actually hit the org-keyed UPDATE with the resolved org id.
    expect(orgPlanUpdateCalls).toHaveLength(1);
    expect(orgPlanUpdateCalls[0]).toEqual(['pro', 'org-personal-1']);
  });

  it('404s with personal_org_not_found when the platform_users row has no personal org', async () => {
    const controlDb = makeControlDbMock((sql) => {
      if (sql.includes('SELECT personal_organization_id FROM platform_users WHERE id = $1')) {
        return { rows: [{ personal_organization_id: null }] };
      }
      return null;
    });

    const app = await makeAppWithOrgForwarding(controlDb, true);
    const r = await app.inject({
      method: 'PATCH',
      url: '/admin/billing/users/user-2/plan',
      headers: { authorization: 'Bearer ok' },
      payload: { plan_id: 'pro' },
    });

    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ error: 'personal_org_not_found' });
  });

  it('404s with personal_org_not_found when the platform_users row does not exist', async () => {
    const controlDb = makeControlDbMock((sql) => {
      if (sql.includes('SELECT personal_organization_id FROM platform_users WHERE id = $1')) {
        return { rows: [] };
      }
      return null;
    });

    const app = await makeAppWithOrgForwarding(controlDb, true);
    const r = await app.inject({
      method: 'PATCH',
      url: '/admin/billing/users/user-missing/plan',
      headers: { authorization: 'Bearer ok' },
      payload: { plan_id: 'pro' },
    });

    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ error: 'personal_org_not_found' });
  });
});
