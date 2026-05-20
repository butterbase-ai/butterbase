import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify from 'fastify';
import pg from 'pg';
import internalAuthPlugin from '../../plugins/internal-auth.js';
import internalLeaseRoutes from './lease.js';
import { grantLease } from '../../services/lease-service.js';

const PLATFORM_URL = process.env.NEON_PLATFORM_PRIMARY_URL
  ?? 'postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control';

let app: ReturnType<typeof Fastify>;
let pool: pg.Pool;
let testUserId: string;

beforeAll(async () => {
  process.env.BUTTERBASE_INTERNAL_SECRET = 'test-secret';
  pool = new pg.Pool({ connectionString: PLATFORM_URL });
  app = Fastify();
  app.decorate('controlDb', pool);
  await app.register(internalAuthPlugin);
  await app.register(internalLeaseRoutes);
  await app.ready();
});

afterAll(async () => { await app.close(); await pool.end(); });

beforeEach(async () => {
  await pool.query(`DELETE FROM credit_leases WHERE user_id = (SELECT id FROM platform_users WHERE email = 'lease-route-test@example.com')`);
  await pool.query(`DELETE FROM platform_users WHERE email = 'lease-route-test@example.com'`);
  const ins = await pool.query(
    `INSERT INTO platform_users (id, email, account_status, plan_id, credits_usd)
     VALUES (gen_random_uuid(), 'lease-route-test@example.com', 'active', 'playground', 5.00)
     RETURNING id`
  );
  testUserId = ins.rows[0].id;
});

describe('POST /v1/internal/lease/grant', () => {
  it('rejects without secret', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/internal/lease/grant',
      payload: { userId: testUserId, region: 'us-east-1', amountUsd: 1 } });
    expect(r.statusCode).toBe(401);
  });

  it('grants a lease with secret', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/internal/lease/grant',
      headers: { 'x-butterbase-internal-secret': 'test-secret', 'content-type': 'application/json' },
      payload: { userId: testUserId, region: 'us-east-1', amountUsd: 1 },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.amountGranted).toBe(1);
    expect(body.leaseId).toBeTruthy();
    expect(typeof body.expiresAt).toBe('string');
  });

  it('400 on missing fields', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/internal/lease/grant',
      headers: { 'x-butterbase-internal-secret': 'test-secret', 'content-type': 'application/json' },
      payload: { region: 'us-east-1' },
    });
    expect(r.statusCode).toBe(400);
  });
});

describe('POST /v1/internal/lease/:lease_id/settle', () => {
  it('settles the lease and returns the refund amount', async () => {
    const grant = await grantLease(pool, {
      userId: testUserId, region: 'us-east-1', amountUsd: 4, ttlSeconds: 60,
    });
    if (!grant.leaseId) throw new Error('grant failed');

    const r = await app.inject({
      method: 'POST',
      url: `/v1/internal/lease/${grant.leaseId}/settle`,
      headers: { 'x-butterbase-internal-secret': 'test-secret', 'content-type': 'application/json' },
      payload: { actualUsd: 1.25 },
    });

    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.refundedUsd).toBeCloseTo(2.75, 2);
  });

  it('rejects calls without the internal secret', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/internal/lease/00000000-0000-0000-0000-000000000000/settle',
      payload: { actualUsd: 1 },
    });
    expect(r.statusCode).toBe(401);
  });

  it('returns 400 on invalid body', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/internal/lease/00000000-0000-0000-0000-000000000000/settle',
      headers: { 'x-butterbase-internal-secret': 'test-secret', 'content-type': 'application/json' },
      payload: { actualUsd: 'not-a-number' },
    });
    expect(r.statusCode).toBe(400);
  });

  it('returns 404 when the lease does not exist', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/internal/lease/00000000-0000-0000-0000-000000000000/settle',
      headers: { 'x-butterbase-internal-secret': 'test-secret', 'content-type': 'application/json' },
      payload: { actualUsd: 1 },
    });
    expect(r.statusCode).toBe(404);
  });
});
