import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import fp from 'fastify-plugin';

vi.mock('../admin-auth.js', () => ({
  requireAdmin: vi.fn(),
}));

vi.mock('../../services/region-resolver.js', () => ({
  fanOutQuery: vi.fn(),
  fanOutRuntimeRegions: vi.fn(),
  getRuntimeDbForApp: vi.fn(),
}));

import { requireAdmin } from '../admin-auth.js';
import { fanOutQuery } from '../../services/region-resolver.js';
import { adminRoutes } from '../admin.js';

const mockRequireAdmin = vi.mocked(requireAdmin);
const mockFanOutQuery = vi.mocked(fanOutQuery);

// The SQL semantics are covered against real Postgres in
// services/paid-conversion.db.test.ts. This file covers only the wiring: that
// /admin/overview runs the conversion query and shapes the response.
function makeControlDbMock(conversionRow: Record<string, number> | null) {
  return {
    query: vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('strict_orgs')) {
        return { rows: conversionRow ? [conversionRow] : [] };
      }
      if (sql.includes('count(*)::int AS c')) return { rows: [{ c: 0 }] };
      return { rows: [] };
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
      { name: 'shim' },
    ),
  );
  await app.register(adminRoutes);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAdmin.mockResolvedValue('admin-uid');
  mockFanOutQuery.mockResolvedValue([]);
});

describe('GET /admin/overview conversion block', () => {
  it('returns counts and derived percentages', async () => {
    const controlDb = makeControlDbMock({
      eligible_users: 889,
      eligible_orgs: 901,
      paying_users: 55,
      paying_orgs: 55,
      broad_paying_users: 89,
      broad_paying_orgs: 89,
    });
    const app = await makeApp(controlDb);

    const r = await app.inject({ method: 'GET', url: '/admin/overview' });

    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.conversion).toBeDefined();
    expect(body.conversion.payingUsers).toBe(55);
    expect(body.conversion.eligibleUsers).toBe(889);
    expect(body.conversion.payingOrgs).toBe(55);
    expect(body.conversion.eligibleOrgs).toBe(901);
    expect(body.conversion.payingUsersPct).toBeCloseTo(6.187, 2);
    expect(body.conversion.payingOrgsPct).toBeCloseTo(6.104, 2);
    expect(body.conversion.broadPayingUsers).toBe(89);
    expect(body.conversion.broadPayingOrgs).toBe(89);
  });

  it('reports zero percent rather than NaN when there are no eligible users', async () => {
    const controlDb = makeControlDbMock({
      eligible_users: 0,
      eligible_orgs: 0,
      paying_users: 0,
      paying_orgs: 0,
      broad_paying_users: 0,
      broad_paying_orgs: 0,
    });
    const app = await makeApp(controlDb);

    const r = await app.inject({ method: 'GET', url: '/admin/overview' });

    expect(r.statusCode).toBe(200);
    expect(r.json().conversion.payingUsersPct).toBe(0);
    expect(r.json().conversion.payingOrgsPct).toBe(0);
  });
});
