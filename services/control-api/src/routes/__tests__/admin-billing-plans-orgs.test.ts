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
  mockFanOutQuery.mockResolvedValue([]);
});

describe('GET /admin/billing/plans/:id subscribers are org-keyed', () => {
  it('returns subscribers with org-keyed shape: organization_id, organization_name, personal, owner_email, subscribed_at', async () => {
    const planId = 'pro';
    const controlDb = makeControlDbMock((sql, params) => {
      // Match plan query
      if (sql.includes('FROM plans WHERE id')) {
        return {
          rows: [{ id: planId, name: 'Pro', price_monthly_cents: 4900 }],
        };
      }
      // Match org-keyed subscribers query
      if (sql.includes('FROM subscriptions s') && sql.includes('JOIN organizations o ON o.id = s.organization_id')) {
        return {
          rows: [
            {
              organization_id: 'org-1',
              organization_name: 'Acme Corp',
              personal: false,
              owner_email: 'owner@acme.com',
              subscribed_at: '2026-01-15T10:00:00Z',
            },
            {
              organization_id: 'org-2',
              organization_name: 'Beta Inc',
              personal: false,
              owner_email: 'owner@beta.com',
              subscribed_at: '2026-02-01T14:30:00Z',
            },
          ],
        };
      }
      // Match billing_events query
      if (sql.includes('FROM billing_events be')) {
        return { rows: [] };
      }
      return null;
    });

    const app = await makeApp(controlDb);
    const r = await app.inject({
      method: 'GET',
      url: `/admin/billing/plans/${planId}`,
      headers: { authorization: 'Bearer ok' },
    });

    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.subscribers).toBeDefined();
    expect(body.subscribers).toHaveLength(2);

    // Verify first subscriber has org-keyed shape
    const sub1 = body.subscribers[0];
    expect(sub1.organization_id).toBe('org-1');
    expect(sub1.organization_name).toBe('Acme Corp');
    expect(sub1.personal).toBe(false);
    expect(sub1.owner_email).toBe('owner@acme.com');
    expect(sub1.subscribed_at).toBe('2026-01-15T10:00:00Z');

    // Verify second subscriber
    const sub2 = body.subscribers[1];
    expect(sub2.organization_id).toBe('org-2');
    expect(sub2.organization_name).toBe('Beta Inc');
    expect(sub2.personal).toBe(false);
    expect(sub2.owner_email).toBe('owner@beta.com');
    expect(sub2.subscribed_at).toBe('2026-02-01T14:30:00Z');
  });

  it('includes all expected fields on each subscriber', async () => {
    const planId = 'pro';
    const controlDb = makeControlDbMock((sql, params) => {
      if (sql.includes('FROM plans WHERE id')) {
        return {
          rows: [{ id: planId, name: 'Pro', price_monthly_cents: 4900 }],
        };
      }
      if (sql.includes('FROM subscriptions s') && sql.includes('JOIN organizations o ON o.id = s.organization_id')) {
        return {
          rows: [
            {
              organization_id: 'org-personal',
              organization_name: 'My Personal Org',
              personal: true,
              owner_email: 'user@example.com',
              subscribed_at: '2026-03-10T12:00:00Z',
            },
          ],
        };
      }
      if (sql.includes('FROM billing_events be')) {
        return { rows: [] };
      }
      return null;
    });

    const app = await makeApp(controlDb);
    const r = await app.inject({
      method: 'GET',
      url: `/admin/billing/plans/${planId}`,
      headers: { authorization: 'Bearer ok' },
    });

    expect(r.statusCode).toBe(200);
    const body = r.json();
    const sub = body.subscribers[0];

    // Verify all required fields are present
    expect(sub).toHaveProperty('organization_id');
    expect(sub).toHaveProperty('organization_name');
    expect(sub).toHaveProperty('personal');
    expect(sub).toHaveProperty('owner_email');
    expect(sub).toHaveProperty('subscribed_at');

    // Verify personal org case
    expect(sub.personal).toBe(true);
  });

  it('returns empty subscribers array when plan has no active subscriptions', async () => {
    const planId = 'free';
    const controlDb = makeControlDbMock((sql, params) => {
      if (sql.includes('FROM plans WHERE id')) {
        return {
          rows: [{ id: planId, name: 'Free', price_monthly_cents: 0 }],
        };
      }
      if (sql.includes('FROM subscriptions s') && sql.includes('JOIN organizations o ON o.id = s.organization_id')) {
        return { rows: [] };
      }
      if (sql.includes('FROM billing_events be')) {
        return { rows: [] };
      }
      return null;
    });

    const app = await makeApp(controlDb);
    const r = await app.inject({
      method: 'GET',
      url: `/admin/billing/plans/${planId}`,
      headers: { authorization: 'Bearer ok' },
    });

    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.subscribers).toBeDefined();
    expect(body.subscribers).toEqual([]);
  });

  it('returns 404 when plan does not exist', async () => {
    const controlDb = makeControlDbMock((sql, params) => {
      if (sql.includes('FROM plans WHERE id')) {
        return { rows: [] };
      }
      return null;
    });

    const app = await makeApp(controlDb);
    const r = await app.inject({
      method: 'GET',
      url: '/admin/billing/plans/nonexistent',
      headers: { authorization: 'Bearer ok' },
    });

    expect(r.statusCode).toBe(404);
    const body = r.json();
    expect(body.error).toBe('Plan not found');
  });

  it('verifies the query joins subscriptions -> organizations -> platform_users (org-keyed)', async () => {
    const controlDb = makeControlDbMock((sql, params) => {
      if (sql.includes('FROM plans WHERE id')) {
        return {
          rows: [{ id: 'pro', name: 'Pro', price_monthly_cents: 4900 }],
        };
      }
      if (sql.includes('FROM subscriptions s') && sql.includes('JOIN organizations o ON o.id = s.organization_id')) {
        // Verify the joins are correct
        expect(sql).toContain('FROM subscriptions s');
        expect(sql).toContain('JOIN organizations o ON o.id = s.organization_id');
        expect(sql).toContain('JOIN platform_users pu ON pu.id = o.owner_id');
        // Verify it does NOT have the old user-keyed join
        expect(sql).not.toContain('JOIN platform_users pu ON s.user_id = pu.id');
        return {
          rows: [
            {
              organization_id: 'org-1',
              organization_name: 'Test Org',
              personal: false,
              owner_email: 'owner@test.com',
              subscribed_at: '2026-01-01T00:00:00Z',
            },
          ],
        };
      }
      if (sql.includes('FROM billing_events be')) {
        return { rows: [] };
      }
      return null;
    });

    const app = await makeApp(controlDb);
    const r = await app.inject({
      method: 'GET',
      url: '/admin/billing/plans/pro',
      headers: { authorization: 'Bearer ok' },
    });

    expect(r.statusCode).toBe(200);
  });

  it('includes recentEvents unchanged (user-keyed)', async () => {
    const controlDb = makeControlDbMock((sql, params) => {
      if (sql.includes('FROM plans WHERE id')) {
        return {
          rows: [{ id: 'pro', name: 'Pro', price_monthly_cents: 4900 }],
        };
      }
      if (sql.includes('FROM subscriptions s') && sql.includes('JOIN organizations o ON o.id = s.organization_id')) {
        return { rows: [] };
      }
      if (sql.includes('FROM billing_events be')) {
        return {
          rows: [
            {
              id: 'event-1',
              user_id: 'user-1',
              email: 'user@example.com',
              event_type: 'subscription_created',
              created_at: '2026-01-01T10:00:00Z',
            },
          ],
        };
      }
      return null;
    });

    const app = await makeApp(controlDb);
    const r = await app.inject({
      method: 'GET',
      url: '/admin/billing/plans/pro',
      headers: { authorization: 'Bearer ok' },
    });

    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.recentEvents).toBeDefined();
    expect(body.recentEvents).toHaveLength(1);
    // Verify recentEvents still has user_id (not org-keyed)
    expect(body.recentEvents[0].user_id).toBe('user-1');
    expect(body.recentEvents[0].email).toBe('user@example.com');
  });
});
