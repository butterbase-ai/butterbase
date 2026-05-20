import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify from 'fastify';
import pg from 'pg';
import { autoRefillRoutes } from './auto-refill.js';

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === '1';
const describeDb = RUN_DB_TESTS ? describe : describe.skip;
const URL = process.env.NEON_PLATFORM_PRIMARY_URL ?? 'postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control';

describeDb('auto-refill routes', () => {
  let app: ReturnType<typeof Fastify>;
  let pool: pg.Pool;
  let userId: string;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: URL });
    app = Fastify();
    app.decorate('controlDb', pool);
    app.addHook('preHandler', async (request) => {
      (request as any).auth = { userId };
    });
    await app.register(autoRefillRoutes);
    await app.ready();
  });
  afterAll(async () => { await app.close(); await pool.end(); });

  beforeEach(async () => {
    const u = await pool.query(
      `INSERT INTO platform_users (email, account_status, plan_id, credits_usd, stripe_customer_id)
       VALUES ($1, 'active', 'playground', 0, $2) RETURNING id`,
      [`auto-refill-test-${Date.now()}-${Math.random()}@x.com`, `cus_test_${Date.now()}_${Math.random()}`]
    );
    userId = u.rows[0].id;
  });

  it('GET returns the disabled defaults', async () => {
    const r = await app.inject({ method: 'GET', url: '/v1/users/me/auto-refill' });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.enabled).toBe(false);
    expect(body.amount_usd).toBeNull();
  });

  it('PUT enables and persists', async () => {
    const r = await app.inject({
      method: 'PUT', url: '/v1/users/me/auto-refill',
      payload: { enabled: true, amount_usd: 20 },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(200);
    const r2 = await app.inject({ method: 'GET', url: '/v1/users/me/auto-refill' });
    expect(r2.json()).toMatchObject({ enabled: true, amount_usd: 20 });
  });

  it('PUT 400 when enabling without amount', async () => {
    const r = await app.inject({
      method: 'PUT', url: '/v1/users/me/auto-refill',
      payload: { enabled: true },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(400);
  });

  it('PUT 400 when amount < 5 or > 500', async () => {
    const lo = await app.inject({
      method: 'PUT', url: '/v1/users/me/auto-refill',
      payload: { enabled: true, amount_usd: 1 },
      headers: { 'content-type': 'application/json' },
    });
    expect(lo.statusCode).toBe(400);
    const hi = await app.inject({
      method: 'PUT', url: '/v1/users/me/auto-refill',
      payload: { enabled: true, amount_usd: 1000 },
      headers: { 'content-type': 'application/json' },
    });
    expect(hi.statusCode).toBe(400);
  });

  it('PUT 400 when enabling without a Stripe customer', async () => {
    await pool.query(`UPDATE platform_users SET stripe_customer_id = NULL WHERE id = $1`, [userId]);
    const r = await app.inject({
      method: 'PUT', url: '/v1/users/me/auto-refill',
      payload: { enabled: true, amount_usd: 20 },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe('NO_PAYMENT_METHOD');
  });
});
