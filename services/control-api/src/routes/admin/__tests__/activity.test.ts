import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import pg from 'pg';
import fp from 'fastify-plugin';

// Mock admin-auth before importing the route so requireAdmin is controllable.
vi.mock('../../admin-auth.js', () => ({
  requireAdmin: vi.fn(),
}));

// Mock region-resolver so tests don't need a real runtime pool.
vi.mock('../../../services/region-resolver.js', () => ({
  getRuntimeDbForApp: vi.fn(),
}));

import { requireAdmin } from '../../admin-auth.js';
import { getRuntimeDbForApp } from '../../../services/region-resolver.js';
import adminActivityRoutes from '../activity.js';

const PLATFORM_URL =
  process.env.NEON_PLATFORM_PRIMARY_URL ??
  'postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control';

let app: ReturnType<typeof Fastify>;
let pool: pg.Pool;

let testUserId: string;
let testOrgId: string;
let testAppId: string;
let testAuditIds: string[] = [];

const mockRequireAdmin = vi.mocked(requireAdmin);
const mockGetRuntimeDbForApp = vi.mocked(getRuntimeDbForApp);

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: PLATFORM_URL });

  // Seed platform user. Post-Plan-05, personal_organization_id is NOT NULL.
  // Create the org first (owner_id has no FK to platform_users).
  testUserId = randomUUID();
  const orgRes = await pool.query<{ id: string }>(
    `INSERT INTO organizations
       (owner_id, name, personal, plan_id, credits_usd, auto_refill_enabled, account_status)
     VALUES ($1, 'test-activity-org', true, 'playground', 0, false, 'active')
     RETURNING id`,
    [testUserId],
  );
  testOrgId = orgRes.rows[0].id;

  await pool.query(
    `INSERT INTO platform_users
       (id, email, account_status, personal_organization_id, last_login_at, last_activity_at)
     VALUES ($1, 'test-activity-user@example.com', 'active', $2, now(), now() - interval '1 day')`,
    [testUserId, testOrgId],
  );

  // Insert 3 activity_daily rows for that user.
  await pool.query(
    `INSERT INTO platform_user_activity_daily (user_id, day, action_count) VALUES
     ($1, CURRENT_DATE,        5),
     ($1, CURRENT_DATE - 1,   3),
     ($1, CURRENT_DATE - 2,   7)
     ON CONFLICT (user_id, day) DO UPDATE SET action_count = EXCLUDED.action_count`,
    [testUserId],
  );

  // Seed an app (owner_id only; other columns have defaults or are nullable).
  testAppId = randomUUID();
  await pool.query(
    `INSERT INTO apps (id, owner_id) VALUES ($1, $2)`,
    [testAppId, testUserId],
  );

  // A frontend visit row so overview total_visits_7d reflects at least 1.
  await pool.query(
    `INSERT INTO frontend_visit_daily (app_id, day, request_count, unique_visitor_count)
     VALUES ($1, CURRENT_DATE, 42, 10)
     ON CONFLICT (app_id, day) DO UPDATE SET request_count = EXCLUDED.request_count`,
    [testAppId],
  );

  // Insert 5 control-plane audit_events for the recent-activity limit test.
  testAuditIds = [];
  for (let i = 0; i < 5; i++) {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO audit_events
         (app_id, category, event_type, action, actor_type, actor_id, success)
       VALUES ($1, 'platform', 'test-activity-event', 'create', 'platform_user', $2, true)
       RETURNING id`,
      [testAppId, testUserId],
    );
    testAuditIds.push(r.rows[0].id);
  }

  app = Fastify({ logger: false });
  await app.register(fp(async (i) => {
    i.decorate('controlDb', pool);
  }, { name: 'test-shim' }));
  await app.register(adminActivityRoutes);
  await app.ready();
});

afterAll(async () => {
  if (testAuditIds.length) {
    await pool.query(`DELETE FROM audit_events WHERE id = ANY($1::uuid[])`, [testAuditIds]);
  }
  if (testAppId) {
    await pool.query(`DELETE FROM frontend_visit_daily WHERE app_id = $1`, [testAppId]);
    await pool.query(`DELETE FROM apps WHERE id = $1`, [testAppId]);
  }
  if (testUserId) {
    await pool.query(`DELETE FROM platform_user_activity_daily WHERE user_id = $1`, [testUserId]);
    // Must delete platform_users before the org (FK: personal_organization_id → organizations.id).
    await pool.query(`DELETE FROM platform_users WHERE id = $1`, [testUserId]);
    await pool.query(`DELETE FROM organizations WHERE id = $1`, [testOrgId]);
  }
  await app.close();
  await pool.end();
});

beforeEach(() => {
  vi.clearAllMocks();
  // Default: auth passes.
  mockRequireAdmin.mockResolvedValue('test-admin-id');
});

// ─── 1. Non-admin → 401 ─────────────────────────────────────────────────────
describe('auth gate', () => {
  it('returns 401 when requireAdmin sends 401', async () => {
    mockRequireAdmin.mockImplementationOnce(async (_fastify, _req, reply) => {
      reply.code(401).send({ error: 'Missing authorization' });
      return null;
    });
    const r = await app.inject({ method: 'GET', url: '/admin/activity/overview' });
    expect(r.statusCode).toBe(401);
  });
});

// ─── 2. Overview → numeric KPI fields ───────────────────────────────────────
describe('GET /admin/activity/overview', () => {
  it('returns all four numeric KPI fields', async () => {
    const r = await app.inject({ method: 'GET', url: '/admin/activity/overview' });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(typeof body.active_platform_users_7d).toBe('number');
    expect(typeof body.active_platform_users_30d).toBe('number');
    expect(typeof body.deploys_7d).toBe('number');
    expect(typeof body.total_visits_7d).toBe('number');
    // Seeded a visit row today, so total should be ≥ 1.
    expect(body.total_visits_7d).toBeGreaterThanOrEqual(1);
  });
});

// ─── 3 & 4. Per-platform-user drill-down ────────────────────────────────────
describe('GET /admin/activity/platform-users/:id', () => {
  it('returns 404 for unknown user id', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/admin/activity/platform-users/00000000-0000-0000-0000-000000000000',
    });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ error: 'not_found' });
  });

  it('returns daily array with 3 rows sorted DESC', async () => {
    const r = await app.inject({
      method: 'GET',
      url: `/admin/activity/platform-users/${testUserId}`,
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(Array.isArray(body.daily)).toBe(true);
    expect(body.daily.length).toBe(3);
    // Sorted DESC: first entry day >= second entry day.
    expect(body.daily[0].day >= body.daily[1].day).toBe(true);
    expect(typeof body.daily[0].action_count).toBe('number');
  });
});

// ─── 5. App end-users: sorted by action_count_7d DESC ───────────────────────
describe('GET /admin/activity/apps/:id/end-users', () => {
  it('returns end-users in descending action_count_7d order', async () => {
    const fakeRows = [
      { app_user_id: 'uid-a', email: 'a@test.com', last_sign_in_at: null, last_activity_at: null, action_count_7d: 10 },
      { app_user_id: 'uid-b', email: 'b@test.com', last_sign_in_at: null, last_activity_at: null, action_count_7d: 2 },
    ];
    const fakeRuntimePool = { query: vi.fn().mockResolvedValue({ rows: fakeRows }) };
    mockGetRuntimeDbForApp.mockResolvedValueOnce(fakeRuntimePool as any);

    const r = await app.inject({
      method: 'GET',
      url: `/admin/activity/apps/${testAppId}/end-users?limit=10`,
    });
    expect(r.statusCode).toBe(200);
    const body: Array<{ app_user_id: string; action_count_7d: number }> = r.json();
    expect(body.length).toBe(2);
    expect(body[0].app_user_id).toBe('uid-a');
    expect(body[0].action_count_7d).toBe(10);
    expect(body[1].app_user_id).toBe('uid-b');
  });

  it('returns 404 for unknown app id', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/admin/activity/apps/00000000-0000-0000-0000-000000000000/end-users',
    });
    expect(r.statusCode).toBe(404);
  });
});

// ─── 6. Recent activity: limit param ────────────────────────────────────────
describe('GET /admin/activity/recent', () => {
  it('respects ?limit=3 — returns at most 3 rows', async () => {
    const r = await app.inject({ method: 'GET', url: '/admin/activity/recent?limit=3' });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeLessThanOrEqual(3);
  });

  it('response rows have correct shape and exclude PII fields', async () => {
    const r = await app.inject({ method: 'GET', url: '/admin/activity/recent?limit=1' });
    expect(r.statusCode).toBe(200);
    const [row] = r.json();
    if (!row) return; // no audit events in DB — shape can't be asserted
    expect(row).toHaveProperty('id');
    expect(row).toHaveProperty('category');
    expect(row).toHaveProperty('event_type');
    expect(row).toHaveProperty('success');
    expect(row).toHaveProperty('created_at');
    // PII fields must NOT be exposed.
    expect(row).not.toHaveProperty('event_data');
    expect(row).not.toHaveProperty('ip_address');
    expect(row).not.toHaveProperty('user_agent');
  });
});
