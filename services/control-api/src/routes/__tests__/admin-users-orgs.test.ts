import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import fp from 'fastify-plugin';

// Mock admin-auth so checkAdmin is controllable
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
import { fanOutQuery } from '../../services/region-resolver.js';
import { adminRoutes } from '../admin.js';

const mockRequireAdmin = vi.mocked(requireAdmin);
const mockFanOutQuery = vi.mocked(fanOutQuery);

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

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAdmin.mockResolvedValue('admin-uid');
  // Mock fanOutQuery to return empty arrays for apps/ai usage
  mockFanOutQuery.mockResolvedValue([]);
});

describe('GET /admin/users/:id includes org memberships', () => {
  it('returns organizations array with both personal + team memberships', async () => {
    const controlDb = makeControlDbMock((sql, params) => {
      if (sql.includes('FROM platform_users pu')) {
        return {
          rows: [
            {
              id: 'user-1',
              email: 'user@example.com',
              display_name: 'User One',
              created_at: '2026-01-01T00:00:00Z',
              signup_source: 'web',
              signup_referrer: null,
              plan_id: 'free',
              account_status: 'active',
              stripe_customer_id: null,
            },
          ],
        };
      }
      if (sql.includes('FROM organization_members m') && sql.includes('JOIN organizations o')) {
        return {
          rows: [
            {
              id: 'org-personal-1',
              name: 'Personal',
              personal: true,
              role: 'owner',
              plan_id: 'free',
              joined_at: '2026-01-01T00:00:00Z',
            },
            {
              id: 'org-team-1',
              name: 'Acme',
              personal: false,
              role: 'member',
              plan_id: 'pro',
              joined_at: '2026-01-15T00:00:00Z',
            },
          ],
        };
      }
      if (sql.includes('FROM suggestions')) {
        return { rows: [] };
      }
      if (sql.includes('FROM audit_events')) {
        return { rows: [] };
      }
      return null;
    });

    const app = await makeApp(controlDb);
    const r = await app.inject({
      method: 'GET',
      url: '/admin/users/user-1',
      headers: { authorization: 'Bearer ok' },
    });

    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.organizations).toBeDefined();
    expect(body.organizations).toHaveLength(2);

    // Verify personal org is first (sorted by personal DESC)
    expect(body.organizations[0].personal).toBe(true);
    expect(body.organizations[0].name).toBe('Personal');
    expect(body.organizations[0].role).toBe('owner');

    // Verify team org is second
    expect(body.organizations[1].personal).toBe(false);
    expect(body.organizations[1].name).toBe('Acme');
    expect(body.organizations[1].role).toBe('member');
  });

  it('personal org sorts first, then by joined_at ascending', async () => {
    const controlDb = makeControlDbMock((sql, params) => {
      if (sql.includes('FROM platform_users pu')) {
        return {
          rows: [
            {
              id: 'user-1',
              email: 'user@example.com',
              display_name: 'User One',
              created_at: '2026-01-01T00:00:00Z',
              signup_source: 'web',
              signup_referrer: null,
              plan_id: 'free',
              account_status: 'active',
              stripe_customer_id: null,
            },
          ],
        };
      }
      if (sql.includes('FROM organization_members m') && sql.includes('JOIN organizations o')) {
        return {
          rows: [
            {
              id: 'org-personal-1',
              name: 'Personal',
              personal: true,
              role: 'owner',
              plan_id: 'free',
              joined_at: '2026-06-01T00:00:00Z', // Later but should come first because personal
            },
            {
              id: 'org-team-a',
              name: 'Team A',
              personal: false,
              role: 'member',
              plan_id: 'pro',
              joined_at: '2026-01-15T00:00:00Z', // Earlier
            },
            {
              id: 'org-team-b',
              name: 'Team B',
              personal: false,
              role: 'owner',
              plan_id: 'pro',
              joined_at: '2026-02-01T00:00:00Z', // Later
            },
          ],
        };
      }
      if (sql.includes('FROM suggestions')) {
        return { rows: [] };
      }
      if (sql.includes('FROM audit_events')) {
        return { rows: [] };
      }
      return null;
    });

    const app = await makeApp(controlDb);
    const r = await app.inject({
      method: 'GET',
      url: '/admin/users/user-1',
      headers: { authorization: 'Bearer ok' },
    });

    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.organizations).toHaveLength(3);

    // Personal org first (personal DESC)
    expect(body.organizations[0].personal).toBe(true);
    expect(body.organizations[0].name).toBe('Personal');

    // Team orgs by joined_at ASC
    expect(body.organizations[1].name).toBe('Team A');
    expect(body.organizations[1].joined_at).toBe('2026-01-15T00:00:00Z');

    expect(body.organizations[2].name).toBe('Team B');
    expect(body.organizations[2].joined_at).toBe('2026-02-01T00:00:00Z');
  });

  it('returns empty organizations array when user has no memberships', async () => {
    const controlDb = makeControlDbMock((sql, params) => {
      if (sql.includes('FROM platform_users pu')) {
        return {
          rows: [
            {
              id: 'user-1',
              email: 'user@example.com',
              display_name: 'User One',
              created_at: '2026-01-01T00:00:00Z',
              signup_source: 'web',
              signup_referrer: null,
              plan_id: null,
              account_status: 'active',
              stripe_customer_id: null,
            },
          ],
        };
      }
      if (sql.includes('FROM organization_members m') && sql.includes('JOIN organizations o')) {
        return { rows: [] };
      }
      if (sql.includes('FROM suggestions')) {
        return { rows: [] };
      }
      if (sql.includes('FROM audit_events')) {
        return { rows: [] };
      }
      return null;
    });

    const app = await makeApp(controlDb);
    const r = await app.inject({
      method: 'GET',
      url: '/admin/users/user-1',
      headers: { authorization: 'Bearer ok' },
    });

    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.organizations).toBeDefined();
    expect(body.organizations).toEqual([]);
  });

  it('includes all fields: id, name, personal, role, plan_id, joined_at', async () => {
    const controlDb = makeControlDbMock((sql, params) => {
      if (sql.includes('FROM platform_users pu')) {
        return {
          rows: [
            {
              id: 'user-1',
              email: 'user@example.com',
              display_name: 'User One',
              created_at: '2026-01-01T00:00:00Z',
              signup_source: 'web',
              signup_referrer: null,
              plan_id: 'free',
              account_status: 'active',
              stripe_customer_id: null,
            },
          ],
        };
      }
      if (sql.includes('FROM organization_members m') && sql.includes('JOIN organizations o')) {
        return {
          rows: [
            {
              id: 'org-1',
              name: 'Test Org',
              personal: false,
              role: 'member',
              plan_id: 'enterprise',
              joined_at: '2026-03-10T12:30:45Z',
            },
          ],
        };
      }
      if (sql.includes('FROM suggestions')) {
        return { rows: [] };
      }
      if (sql.includes('FROM audit_events')) {
        return { rows: [] };
      }
      return null;
    });

    const app = await makeApp(controlDb);
    const r = await app.inject({
      method: 'GET',
      url: '/admin/users/user-1',
      headers: { authorization: 'Bearer ok' },
    });

    expect(r.statusCode).toBe(200);
    const body = r.json();
    const org = body.organizations[0];
    expect(org).toHaveProperty('id');
    expect(org).toHaveProperty('name');
    expect(org).toHaveProperty('personal');
    expect(org).toHaveProperty('role');
    expect(org).toHaveProperty('plan_id');
    expect(org).toHaveProperty('joined_at');

    expect(org.id).toBe('org-1');
    expect(org.name).toBe('Test Org');
    expect(org.personal).toBe(false);
    expect(org.role).toBe('member');
    expect(org.plan_id).toBe('enterprise');
    expect(org.joined_at).toBe('2026-03-10T12:30:45Z');
  });
});
