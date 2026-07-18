import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import organizationsRoutes from './organizations.js';
import { fanOutQuery } from '../../services/region-resolver.js';

vi.mock('../../services/region-resolver.js', () => ({
  fanOutQuery: vi.fn(),
  fanOutRuntimeRegions: vi.fn(),
  getRuntimeDbForApp: vi.fn(),
}));

function makeControlDbMock(handlers: (sql: string, params: unknown[]) => { rows: any[] } | null) {
  const query = vi.fn().mockImplementation(async (sql: string, params: unknown[]) => {
    const r = handlers(sql, params);
    return r ?? { rows: [] };
  });
  // Routes that need a transaction call `controlDb.connect()` and drive
  // BEGIN/COMMIT/ROLLBACK through the returned client. Route the client's
  // queries through the same handler so tests can assert on the same SQL
  // fragments regardless of whether the route uses `.query` or `.connect()`.
  const client = { query, release: vi.fn() };
  return { query, connect: vi.fn().mockResolvedValue(client) };
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

  it('applies a SQL-side LIMIT capped at limit+offset (bounded fetch)', async () => {
    let capturedParams: unknown[] = [];
    const controlDb = makeControlDbMock((sql, params) => {
      if (sql.includes('FROM organizations o')) {
        capturedParams = params;
        expect(sql).toMatch(/LIMIT \$\d+/);
        return { rows: [] };
      }
      return null;
    });
    const app = await makeApp(controlDb, true);
    const r = await app.inject({
      method: 'GET',
      url: '/admin/organizations?limit=10&offset=5',
      headers: { authorization: 'Bearer ok' },
    });
    expect(r.statusCode).toBe(200);
    // fetchCap = Math.min(limit + offset, 1000) = min(15, 1000) = 15
    expect(capturedParams[capturedParams.length - 1]).toBe(15);
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

  it('400s with offset_too_large when offset >= 1000', async () => {
    const controlDb = makeControlDbMock(() => null);
    const app = await makeApp(controlDb, true);
    const r = await app.inject({
      method: 'GET',
      url: '/admin/organizations?offset=1001',
      headers: { authorization: 'Bearer ok' },
    });
    expect(r.statusCode).toBe(400);
    const body = JSON.parse(r.body);
    expect(body).toEqual({
      error: 'offset_too_large',
      message: 'Pagination offset must be < 1000. Use search/filter params to narrow.',
    });
  });
});

describe('GET /admin/organizations/:id', () => {
  beforeEach(() => vi.clearAllMocks());

  const orgRow = {
    id: 'org-1', name: 'Acme', personal: false, owner_id: 'u1', owner_email: 'a@a.com',
    plan_id: 'pro', account_status: 'active', stripe_customer_id: null,
    credits_usd: 10, monthly_allowance_usd: 5, created_at: '2026-01-01T00:00:00Z',
    auto_refill_enabled: true, auto_refill_amount_usd: 20,
    auto_refill_last_attempt_at: '2026-01-05T00:00:00Z', auto_refill_last_failure_reason: null,
    billing_period_start: '2026-01-01',
  };

  // The mock returns rows verbatim (it doesn't execute the SQL's ORDER BY),
  // so the fixture is pre-sorted owner-first to match what the real query
  // would return via `ORDER BY m.role = 'owner' DESC, m.joined_at ASC`.
  const membersRows = [
    { user_id: 'u1', email: 'a@a.com', display_name: 'Owner', role: 'owner', invited_by: null, joined_at: '2026-01-01T00:00:00Z' },
    { user_id: 'u2', email: 'member@a.com', display_name: 'Member', role: 'member', invited_by: 'u1', joined_at: '2026-01-02T00:00:00Z' },
  ];

  const appIndexRows = [{ app_id: 'app-1', region: 'us-east-1' }];

  const subRow = {
    plan_id: 'pro', plan_name: 'Pro', status: 'active', price_monthly_cents: 2900, started_at: '2026-01-01T00:00:00Z',
  };

  const eventRows = [
    { id: 'ev-1', event_type: 'charge', created_at: '2026-01-03T00:00:00Z' },
    { id: 'ev-2', event_type: 'refund', created_at: '2026-01-02T00:00:00Z' },
  ];

  function makeDetailControlDbMock(opts: {
    org?: any[]; members?: any[]; appIndex?: any[]; sub?: any[]; events?: any[];
  }) {
    return makeControlDbMock((sql) => {
      if (sql.includes('FROM organizations o') && sql.includes('WHERE o.id')) {
        return { rows: opts.org ?? [] };
      }
      if (sql.includes('FROM organization_members')) {
        return { rows: opts.members ?? [] };
      }
      if (sql.includes('FROM org_app_index')) {
        return { rows: opts.appIndex ?? [] };
      }
      if (sql.includes('FROM subscriptions')) {
        return { rows: opts.sub ?? [] };
      }
      if (sql.includes('FROM billing_events')) {
        return { rows: opts.events ?? [] };
      }
      return null;
    });
  }

  it('404s on unknown org id', async () => {
    const controlDb = makeDetailControlDbMock({ org: [] });
    const app = await makeApp(controlDb, true);
    const r = await app.inject({ method: 'GET', url: '/admin/organizations/does-not-exist', headers: { authorization: 'Bearer ok' } });
    expect(r.statusCode).toBe(404);
    expect(JSON.parse(r.body)).toEqual({ error: 'organization_not_found' });
  });

  it('returns the full composite detail shape', async () => {
    const controlDb = makeDetailControlDbMock({
      org: [orgRow], members: membersRows, appIndex: appIndexRows, sub: [subRow], events: eventRows,
    });
    vi.mocked(fanOutQuery).mockResolvedValue([
      { id: 'app-1', name: 'My App', region: 'us-east-1', owner_id: 'u1', db_provisioned: true, deployment_url: 'https://app.example.com', last_deployed_at: '2026-01-04T00:00:00Z', created_at: '2026-01-01T00:00:00Z' },
    ]);
    const app = await makeApp(controlDb, true);
    const r = await app.inject({ method: 'GET', url: '/admin/organizations/org-1', headers: { authorization: 'Bearer ok' } });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);

    expect(body.org.id).toBe('org-1');
    expect(body.org.auto_refill_enabled).toBe(true);
    expect(body.org.billing_period_start).toBe('2026-01-01');
    // member_count is derived from the members query result, not a second
    // correlated subquery on the org row (whole-branch review, Important 8).
    expect(body.org.member_count).toBe(2);

    expect(body.members).toHaveLength(2);
    expect(body.members[0].role).toBe('owner');
    expect(body.members[0].email).toBe('a@a.com');

    expect(body.apps).toHaveLength(1);
    expect(body.apps[0].id).toBe('app-1');
    expect(vi.mocked(fanOutQuery)).toHaveBeenCalledWith(expect.any(String), [['app-1']]);

    expect(body.subscription).toEqual({
      plan_id: 'pro', plan_name: 'Pro', status: 'active', price_monthly_cents: 2900, started_at: '2026-01-01T00:00:00Z',
    });

    expect(body.recentBillingEvents).toHaveLength(2);

    expect(body.creditsLedger).toEqual({
      credits_usd: 10,
      monthly_allowance_usd: 5,
      auto_refill_enabled: true,
      auto_refill_amount_usd: 20,
      auto_refill_last_attempt_at: '2026-01-05T00:00:00Z',
      auto_refill_last_failure_reason: null,
    });
  });

  it('returns empty apps without calling fanOutQuery when org has no apps', async () => {
    const controlDb = makeDetailControlDbMock({
      org: [orgRow], members: membersRows, appIndex: [], sub: [], events: [],
    });
    const app = await makeApp(controlDb, true);
    const r = await app.inject({ method: 'GET', url: '/admin/organizations/org-1', headers: { authorization: 'Bearer ok' } });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.apps).toEqual([]);
    expect(body.subscription).toBeNull();
    expect(vi.mocked(fanOutQuery)).not.toHaveBeenCalled();
  });
});

describe('POST /admin/organizations/:id/members', () => {
  beforeEach(() => vi.clearAllMocks());

  it('inserts a member and returns 201 with email + display_name', async () => {
    const controlDb = makeControlDbMock((sql) => {
      if (sql.includes('SELECT 1 FROM organizations')) return { rows: [{ '?column?': 1 }] };
      if (sql.includes('SELECT 1 FROM platform_users')) return { rows: [{ '?column?': 1 }] };
      if (sql.includes('INSERT INTO organization_members')) {
        return {
          rows: [{
            organization_id: 'org-1', user_id: 'user-2', role: 'member',
            invited_by: 'admin-uid', joined_at: '2026-01-01T00:00:00Z',
            email: 'user2@example.com', display_name: 'User Two',
          }],
        };
      }
      return null;
    });
    const app = await makeApp(controlDb, true);
    const r = await app.inject({
      method: 'POST',
      url: '/admin/organizations/org-1/members',
      headers: { authorization: 'Bearer ok' },
      payload: { user_id: 'user-2', role: 'member' },
    });
    expect(r.statusCode).toBe(201);
    const body = JSON.parse(r.body);
    expect(body.member).toEqual({
      organization_id: 'org-1', user_id: 'user-2', role: 'member',
      invited_by: 'admin-uid', joined_at: '2026-01-01T00:00:00Z',
      email: 'user2@example.com', display_name: 'User Two',
    });
  });

  it('400s on invalid role', async () => {
    const controlDb = makeControlDbMock(() => null);
    const app = await makeApp(controlDb, true);
    const r = await app.inject({
      method: 'POST',
      url: '/admin/organizations/org-1/members',
      headers: { authorization: 'Bearer ok' },
      payload: { user_id: 'user-2', role: 'admin' },
    });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body)).toEqual({ error: 'invalid_role' });
  });

  it('400s when user_id is missing', async () => {
    const controlDb = makeControlDbMock(() => null);
    const app = await makeApp(controlDb, true);
    const r = await app.inject({
      method: 'POST',
      url: '/admin/organizations/org-1/members',
      headers: { authorization: 'Bearer ok' },
      payload: { role: 'member' },
    });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body)).toEqual({ error: 'user_id_required' });
  });

  it('404s when organization does not exist', async () => {
    const controlDb = makeControlDbMock((sql) => {
      if (sql.includes('SELECT 1 FROM organizations')) return { rows: [] };
      return null;
    });
    const app = await makeApp(controlDb, true);
    const r = await app.inject({
      method: 'POST',
      url: '/admin/organizations/missing-org/members',
      headers: { authorization: 'Bearer ok' },
      payload: { user_id: 'user-2', role: 'member' },
    });
    expect(r.statusCode).toBe(404);
    expect(JSON.parse(r.body)).toEqual({ error: 'organization_not_found' });
  });

  it('404s when the target user does not exist', async () => {
    const controlDb = makeControlDbMock((sql) => {
      if (sql.includes('SELECT 1 FROM organizations')) return { rows: [{ '?column?': 1 }] };
      if (sql.includes('SELECT 1 FROM platform_users')) return { rows: [] };
      return null;
    });
    const app = await makeApp(controlDb, true);
    const r = await app.inject({
      method: 'POST',
      url: '/admin/organizations/org-1/members',
      headers: { authorization: 'Bearer ok' },
      payload: { user_id: 'missing-user', role: 'member' },
    });
    expect(r.statusCode).toBe(404);
    expect(JSON.parse(r.body)).toEqual({ error: 'user_not_found' });
  });
});

describe('PATCH /admin/organizations/:id/members/:user_id', () => {
  beforeEach(() => vi.clearAllMocks());

  it('changes a member role and returns 200 with email + display_name', async () => {
    const controlDb = makeControlDbMock((sql) => {
      if (sql.includes('SELECT 1 FROM organizations')) return { rows: [{ '?column?': 1 }] };
      if (sql.includes('UPDATE organization_members') && sql.includes('RETURNING')) {
        return {
          rows: [{
            organization_id: 'org-1', user_id: 'user-2', role: 'owner',
            invited_by: null, joined_at: '2026-01-01T00:00:00Z',
          }],
        };
      }
      if (sql.includes('count(*)::int AS c')) return { rows: [{ c: 2 }] };
      if (sql.includes('FROM organization_members m') && sql.includes('JOIN platform_users')) {
        return {
          rows: [{
            organization_id: 'org-1', user_id: 'user-2', role: 'owner',
            invited_by: null, joined_at: '2026-01-01T00:00:00Z',
            email: 'user2@example.com', display_name: 'User Two',
          }],
        };
      }
      return null;
    });
    const app = await makeApp(controlDb, true);
    const r = await app.inject({
      method: 'PATCH',
      url: '/admin/organizations/org-1/members/user-2',
      headers: { authorization: 'Bearer ok' },
      payload: { role: 'owner' },
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.member.role).toBe('owner');
    expect(body.member.email).toBe('user2@example.com');
    expect(body.member.display_name).toBe('User Two');
  });

  it('400s on invalid role', async () => {
    const controlDb = makeControlDbMock(() => null);
    const app = await makeApp(controlDb, true);
    const r = await app.inject({
      method: 'PATCH',
      url: '/admin/organizations/org-1/members/user-2',
      headers: { authorization: 'Bearer ok' },
      payload: { role: 'admin' },
    });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body)).toEqual({ error: 'invalid_role' });
  });

  it('404s when organization does not exist', async () => {
    const controlDb = makeControlDbMock((sql) => {
      if (sql.includes('SELECT 1 FROM organizations')) return { rows: [] };
      return null;
    });
    const app = await makeApp(controlDb, true);
    const r = await app.inject({
      method: 'PATCH',
      url: '/admin/organizations/missing-org/members/user-2',
      headers: { authorization: 'Bearer ok' },
      payload: { role: 'member' },
    });
    expect(r.statusCode).toBe(404);
    expect(JSON.parse(r.body)).toEqual({ error: 'organization_not_found' });
  });

  it('404s when member does not exist', async () => {
    const controlDb = makeControlDbMock((sql) => {
      if (sql.includes('SELECT 1 FROM organizations')) return { rows: [{ '?column?': 1 }] };
      if (sql.includes('UPDATE organization_members') && sql.includes('RETURNING')) return { rows: [] };
      return null;
    });
    const app = await makeApp(controlDb, true);
    const r = await app.inject({
      method: 'PATCH',
      url: '/admin/organizations/org-1/members/missing-user',
      headers: { authorization: 'Bearer ok' },
      payload: { role: 'member' },
    });
    expect(r.statusCode).toBe(404);
    expect(JSON.parse(r.body)).toEqual({ error: 'member_not_found' });
  });

  it('400s with last_owner and rolls back the whole transaction when demoting the sole owner', async () => {
    const queryCalls: string[] = [];
    const controlDb = makeControlDbMock((sql) => {
      queryCalls.push(sql);
      if (sql.includes('SELECT 1 FROM organizations')) return { rows: [{ '?column?': 1 }] };
      if (sql.includes('UPDATE organization_members') && sql.includes('RETURNING')) {
        return {
          rows: [{
            organization_id: 'org-1', user_id: 'owner-1', role: 'member',
            invited_by: null, joined_at: '2026-01-01T00:00:00Z',
          }],
        };
      }
      if (sql.includes('count(*)::int AS c')) {
        expect(sql).toContain('FOR UPDATE');
        return { rows: [{ c: 0 }] };
      }
      return null;
    });
    const app = await makeApp(controlDb, true);
    const r = await app.inject({
      method: 'PATCH',
      url: '/admin/organizations/org-1/members/owner-1',
      headers: { authorization: 'Bearer ok' },
      payload: { role: 'member' },
    });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body)).toEqual({ error: 'last_owner' });
    // The demote UPDATE happened inside a transaction that then rolled back
    // — no manual "SET role = 'owner'" revert query is issued anymore.
    expect(queryCalls).toContain('BEGIN');
    expect(queryCalls).toContain('ROLLBACK');
    expect(queryCalls.some((s) => s.includes("SET role = 'owner'"))).toBe(false);
  });
});

describe('DELETE /admin/organizations/:id/members/:user_id', () => {
  beforeEach(() => vi.clearAllMocks());

  it('removes a non-owner member and returns 204', async () => {
    const queryCalls: string[] = [];
    const controlDb = makeControlDbMock((sql) => {
      queryCalls.push(sql);
      if (sql.includes('SELECT role FROM organization_members')) {
        expect(sql).toContain('FOR UPDATE');
        return { rows: [{ role: 'member' }] };
      }
      if (sql.includes('DELETE FROM organization_members')) return { rows: [] };
      return null;
    });
    const app = await makeApp(controlDb, true);
    const r = await app.inject({
      method: 'DELETE',
      url: '/admin/organizations/org-1/members/user-2',
      headers: { authorization: 'Bearer ok' },
    });
    expect(r.statusCode).toBe(204);
    expect(r.body).toBe('');
    expect(queryCalls).toContain('BEGIN');
    expect(queryCalls).toContain('COMMIT');
  });

  it('400s with last_owner when the sole owner is targeted', async () => {
    const controlDb = makeControlDbMock((sql) => {
      if (sql.includes('SELECT role FROM organization_members')) return { rows: [{ role: 'owner' }] };
      if (sql.includes('count(*)::int AS c')) {
        expect(sql).toContain('FOR UPDATE');
        return { rows: [{ c: 1 }] };
      }
      return null;
    });
    const app = await makeApp(controlDb, true);
    const r = await app.inject({
      method: 'DELETE',
      url: '/admin/organizations/org-1/members/owner-1',
      headers: { authorization: 'Bearer ok' },
    });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body)).toEqual({ error: 'last_owner' });
  });

  it('404s when member does not exist', async () => {
    const controlDb = makeControlDbMock((sql) => {
      if (sql.includes('SELECT role FROM organization_members')) return { rows: [] };
      return null;
    });
    const app = await makeApp(controlDb, true);
    const r = await app.inject({
      method: 'DELETE',
      url: '/admin/organizations/org-1/members/missing-user',
      headers: { authorization: 'Bearer ok' },
    });
    expect(r.statusCode).toBe(404);
    expect(JSON.parse(r.body)).toEqual({ error: 'member_not_found' });
  });
});

describe('PATCH /admin/organizations/:id/plan', () => {
  beforeEach(() => vi.clearAllMocks());

  it('200 assigns plan, inserts a new subscription (none existed), and emits a billing_event', async () => {
    const subscriptionSelects: unknown[][] = [];
    const subscriptionInserts: unknown[][] = [];
    const subscriptionUpdates: unknown[][] = [];
    const billingEventInserts: unknown[][] = [];

    const controlDb = makeControlDbMock((sql, params) => {
      if (sql.includes('SELECT id FROM plans WHERE id = $1')) {
        return { rows: [{ id: 'enterprise-acme' }] };
      }
      if (sql.includes('UPDATE organizations') && sql.includes('RETURNING')) {
        return { rows: [{ id: 'org-1', plan_id: 'enterprise-acme', account_status: 'active' }] };
      }
      if (sql.includes('SELECT') && sql.includes('FROM subscriptions') && sql.includes('WHERE organization_id')) {
        subscriptionSelects.push(params);
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO subscriptions')) {
        subscriptionInserts.push(params);
        return { rows: [{ id: 'sub-1' }] };
      }
      if (sql.includes('UPDATE subscriptions')) {
        subscriptionUpdates.push(params);
        return { rows: [{ id: 'sub-1' }] };
      }
      if (sql.includes('INSERT INTO billing_events')) {
        billingEventInserts.push(params);
        return { rows: [{ id: 'evt-1' }] };
      }
      return null;
    });

    const app = await makeApp(controlDb, true);
    const r = await app.inject({
      method: 'PATCH',
      url: '/admin/organizations/org-1/plan',
      headers: { authorization: 'Bearer ok' },
      payload: { plan_id: 'enterprise-acme', stripe_price_id: 'price_123' },
    });

    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body).toEqual({ organization: { id: 'org-1', plan_id: 'enterprise-acme', account_status: 'active' } });

    expect(subscriptionSelects).toHaveLength(1);
    expect(subscriptionInserts).toHaveLength(1);
    expect(subscriptionInserts[0]).toEqual(['org-1', 'enterprise-acme', 'price_123']);
    expect(subscriptionUpdates).toHaveLength(0);

    expect(billingEventInserts).toHaveLength(1);
    expect(billingEventInserts[0][0]).toBe('org-1');
    const payload = JSON.parse(billingEventInserts[0][1] as string);
    expect(payload).toEqual({ plan_id: 'enterprise-acme', stripe_price_id: 'price_123' });
  });

  it('200 assigns plan and updates the existing subscription row (no INSERT)', async () => {
    const subscriptionInserts: unknown[][] = [];
    const subscriptionUpdates: unknown[][] = [];

    const controlDb = makeControlDbMock((sql, params) => {
      if (sql.includes('SELECT id FROM plans WHERE id = $1')) {
        return { rows: [{ id: 'pro' }] };
      }
      if (sql.includes('UPDATE organizations') && sql.includes('RETURNING')) {
        return { rows: [{ id: 'org-1', plan_id: 'pro', account_status: 'active' }] };
      }
      if (sql.includes('SELECT') && sql.includes('FROM subscriptions') && sql.includes('WHERE organization_id')) {
        return { rows: [{ id: 'sub-existing' }] };
      }
      if (sql.includes('INSERT INTO subscriptions')) {
        subscriptionInserts.push(params);
        return { rows: [{ id: 'sub-1' }] };
      }
      if (sql.includes('UPDATE subscriptions')) {
        subscriptionUpdates.push(params);
        return { rows: [{ id: 'sub-existing' }] };
      }
      if (sql.includes('INSERT INTO billing_events')) {
        return { rows: [{ id: 'evt-1' }] };
      }
      return null;
    });

    const app = await makeApp(controlDb, true);
    const r = await app.inject({
      method: 'PATCH',
      url: '/admin/organizations/org-1/plan',
      headers: { authorization: 'Bearer ok' },
      payload: { plan_id: 'pro' },
    });

    expect(r.statusCode).toBe(200);
    expect(subscriptionInserts).toHaveLength(0);
    expect(subscriptionUpdates).toHaveLength(1);
  });

  it('400s with plan_id_required when body is empty', async () => {
    const controlDb = makeControlDbMock(() => null);
    const app = await makeApp(controlDb, true);
    const r = await app.inject({
      method: 'PATCH',
      url: '/admin/organizations/org-1/plan',
      headers: { authorization: 'Bearer ok' },
      payload: {},
    });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body)).toEqual({ error: 'plan_id_required' });
  });

  it('404s with plan_not_found when the plan lookup is empty', async () => {
    const controlDb = makeControlDbMock((sql) => {
      if (sql.includes('SELECT id FROM plans WHERE id = $1')) return { rows: [] };
      return null;
    });
    const app = await makeApp(controlDb, true);
    const r = await app.inject({
      method: 'PATCH',
      url: '/admin/organizations/org-1/plan',
      headers: { authorization: 'Bearer ok' },
      payload: { plan_id: 'nonexistent' },
    });
    expect(r.statusCode).toBe(404);
    expect(JSON.parse(r.body)).toEqual({ error: 'plan_not_found' });
  });

  it('404s with organization_not_found when the organizations UPDATE affects 0 rows', async () => {
    const controlDb = makeControlDbMock((sql) => {
      if (sql.includes('SELECT id FROM plans WHERE id = $1')) return { rows: [{ id: 'pro' }] };
      if (sql.includes('UPDATE organizations') && sql.includes('RETURNING')) return { rows: [] };
      return null;
    });
    const app = await makeApp(controlDb, true);
    const r = await app.inject({
      method: 'PATCH',
      url: '/admin/organizations/org-missing/plan',
      headers: { authorization: 'Bearer ok' },
      payload: { plan_id: 'pro' },
    });
    expect(r.statusCode).toBe(404);
    expect(JSON.parse(r.body)).toEqual({ error: 'organization_not_found' });
  });
});
