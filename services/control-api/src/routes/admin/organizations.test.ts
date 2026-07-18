import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import organizationsRoutes from './organizations.js';

function makeControlDbMock(handlers: (sql: string, params: unknown[]) => { rows: any[] } | null) {
  return { query: vi.fn().mockImplementation(async (sql: string, params: unknown[]) => {
    const r = handlers(sql, params);
    return r ?? { rows: [] };
  }) };
}

async function makeApp(controlDb: any, isAdmin = true) {
  const app = Fastify({ logger: false });
  const fp = (await import('fastify-plugin')).default;
  await app.register(fp(async (i: any) => {
    // Ensure the very first platform_users lookup (requireAdmin) sees is_admin.
    const original = controlDb.query;
    controlDb.query = vi.fn().mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes('FROM platform_users') && sql.includes('is_admin')) {
        return { rows: [{ id: 'admin-uid', email: 'admin@example.com', display_name: null, is_admin: isAdmin }] };
      }
      return original(sql, params);
    });
    i.decorate('controlDb', controlDb);
    i.decorate('authProvider', { async verifyJwt() { return { sub: 'sub-1' }; } });
  }, { name: 'shim' }));
  await app.register(organizationsRoutes);
  return app;
}

describe('GET /admin/organizations', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 403 for non-admin', async () => {
    const controlDb = makeControlDbMock(() => null);
    const app = await makeApp(controlDb, false);
    const r = await app.inject({ method: 'GET', url: '/admin/organizations', headers: { authorization: 'Bearer ok' } });
    expect(r.statusCode).toBe(403);
  });

  it('returns 200 with list + app_count merged', async () => {
    const controlDb = makeControlDbMock((sql) => {
      if (sql.includes('FROM organizations o')) {
        return {
          rows: [
            {
              id: 'org-1', name: 'Acme', personal: false, owner_id: 'u1', owner_email: 'a@a.com',
              plan_id: 'pro', account_status: 'active', stripe_customer_id: null,
              credits_usd: 10, monthly_allowance_usd: 5, created_at: '2026-01-01T00:00:00Z', member_count: 2,
            },
            {
              id: 'org-2', name: 'Personal', personal: true, owner_id: 'u1', owner_email: 'a@a.com',
              plan_id: 'free', account_status: 'active', stripe_customer_id: null,
              credits_usd: 0, monthly_allowance_usd: 0, created_at: '2026-01-02T00:00:00Z', member_count: 1,
            },
          ],
        };
      }
      if (sql.includes('FROM org_app_index')) {
        return { rows: [{ organization_id: 'org-1', app_count: 3 }] };
      }
      return null;
    });
    const app = await makeApp(controlDb, true);
    const r = await app.inject({ method: 'GET', url: '/admin/organizations', headers: { authorization: 'Bearer ok' } });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.total).toBe(2);
    const acme = body.data.find((row: any) => row.name === 'Acme');
    expect(acme.app_count).toBe(3);
    expect(acme.member_count).toBe(2);
    expect(acme.plan_id).toBe('pro');
    const personal = body.data.find((row: any) => row.name === 'Personal');
    expect(personal.app_count).toBe(0);
  });

  it('filters by personal=no', async () => {
    const controlDb = makeControlDbMock((sql, params) => {
      if (sql.includes('FROM organizations o')) {
        expect(sql).toContain('o.personal = false');
        return {
          rows: [
            {
              id: 'org-1', name: 'Acme', personal: false, owner_id: 'u1', owner_email: 'a@a.com',
              plan_id: 'pro', account_status: 'active', stripe_customer_id: null,
              credits_usd: 10, monthly_allowance_usd: 5, created_at: '2026-01-01T00:00:00Z', member_count: 2,
            },
          ],
        };
      }
      if (sql.includes('FROM org_app_index')) {
        return { rows: [] };
      }
      return null;
    });
    const app = await makeApp(controlDb, true);
    const r = await app.inject({ method: 'GET', url: '/admin/organizations?personal=no', headers: { authorization: 'Bearer ok' } });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.data.every((row: any) => row.personal === false)).toBe(true);
  });
});
