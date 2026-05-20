import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { reclaimExpiredLeases } from './lease-reclaim.js';
import { grantLease } from './lease-service.js';

const PLATFORM_URL = process.env.NEON_PLATFORM_PRIMARY_URL
  ?? 'postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control';

let pool: pg.Pool;
let testUserId: string;

beforeAll(async () => { pool = new pg.Pool({ connectionString: PLATFORM_URL }); });
afterAll(async () => { await pool.end(); });

beforeEach(async () => {
  await pool.query(`DELETE FROM credit_leases WHERE user_id = (SELECT id FROM platform_users WHERE email = 'reclaim-test@example.com')`);
  await pool.query(`DELETE FROM platform_users WHERE email = 'reclaim-test@example.com'`);
  const ins = await pool.query(
    `INSERT INTO platform_users (id, email, account_status, plan_id, credits_usd)
     VALUES (gen_random_uuid(), 'reclaim-test@example.com', 'active', 'playground', 5.00)
     RETURNING id`
  );
  testUserId = ins.rows[0].id;
});

describe('reclaimExpiredLeases', () => {
  it('reclaims an expired active lease and credits balance', async () => {
    const grant = await grantLease(pool, { userId: testUserId, region: 'us-east-1', amountUsd: 1, ttlSeconds: 300 });
    await pool.query(`UPDATE credit_leases SET expires_at = now() - interval '60 seconds' WHERE lease_id = $1`, [grant.leaseId]);
    const r = await reclaimExpiredLeases(pool, 30);
    expect(r.reclaimed).toBe(1);
    const lease = await pool.query(`SELECT status FROM credit_leases WHERE lease_id = $1`, [grant.leaseId]);
    expect(lease.rows[0].status).toBe('reclaimed');
    const u = await pool.query(`SELECT credits_usd FROM platform_users WHERE id = $1`, [testUserId]);
    expect(parseFloat(u.rows[0].credits_usd)).toBeCloseTo(5, 2);
  });

  it('does not reclaim leases within the grace window', async () => {
    await grantLease(pool, { userId: testUserId, region: 'us-east-1', amountUsd: 1, ttlSeconds: 1 });
    const r = await reclaimExpiredLeases(pool, 30);
    expect(r.reclaimed).toBe(0);
  });

  it('skips already-reclaimed leases', async () => {
    const grant = await grantLease(pool, { userId: testUserId, region: 'us-east-1', amountUsd: 1, ttlSeconds: 300 });
    await pool.query(`UPDATE credit_leases SET expires_at = now() - interval '60 seconds', status = 'reclaimed' WHERE lease_id = $1`, [grant.leaseId]);
    const r = await reclaimExpiredLeases(pool, 30);
    expect(r.reclaimed).toBe(0);
  });
});

describe('reclaimExpiredLeases — split pools', () => {
  it('refunds monthly-only lease back to monthly_allowance', async () => {
    await pool.query(`UPDATE platform_users SET monthly_allowance_usd = 10, credits_usd = 0 WHERE id = $1`, [testUserId]);
    const grant = await grantLease(pool, { userId: testUserId, region: 'test', amountUsd: 4, ttlSeconds: 60 });
    if (!grant.leaseId) throw new Error('grant failed');
    // After grant: monthly = 6, credits = 0.
    await pool.query(`UPDATE credit_leases SET expires_at = now() - interval '1 minute' WHERE lease_id = $1`, [grant.leaseId]);
    const result = await reclaimExpiredLeases(pool, 0);
    expect(result.reclaimed).toBeGreaterThanOrEqual(1);
    const u = await pool.query(`SELECT monthly_allowance_usd, credits_usd FROM platform_users WHERE id = $1`, [testUserId]);
    expect(parseFloat(u.rows[0].monthly_allowance_usd)).toBeCloseTo(10, 4); // 6 + 4
    expect(parseFloat(u.rows[0].credits_usd)).toBeCloseTo(0, 4);
  });

  it('refunds topup-only lease back to credits_usd', async () => {
    await pool.query(`UPDATE platform_users SET monthly_allowance_usd = 0, credits_usd = 10 WHERE id = $1`, [testUserId]);
    const grant = await grantLease(pool, { userId: testUserId, region: 'test', amountUsd: 4, ttlSeconds: 60 });
    if (!grant.leaseId) throw new Error('grant failed');
    await pool.query(`UPDATE credit_leases SET expires_at = now() - interval '1 minute' WHERE lease_id = $1`, [grant.leaseId]);
    await reclaimExpiredLeases(pool, 0);
    const u = await pool.query(`SELECT monthly_allowance_usd, credits_usd FROM platform_users WHERE id = $1`, [testUserId]);
    expect(parseFloat(u.rows[0].monthly_allowance_usd)).toBeCloseTo(0, 4);
    expect(parseFloat(u.rows[0].credits_usd)).toBeCloseTo(10, 4);
  });

  it('refunds split lease back to both pools by original portions', async () => {
    await pool.query(`UPDATE platform_users SET monthly_allowance_usd = 1, credits_usd = 10 WHERE id = $1`, [testUserId]);
    const grant = await grantLease(pool, { userId: testUserId, region: 'test', amountUsd: 3, ttlSeconds: 60 });
    if (!grant.leaseId) throw new Error('grant failed');
    // After grant: monthly = 0 (was 1, drew 1), credits = 8 (was 10, drew 2 from split).
    await pool.query(`UPDATE credit_leases SET expires_at = now() - interval '1 minute' WHERE lease_id = $1`, [grant.leaseId]);
    await reclaimExpiredLeases(pool, 0);
    const u = await pool.query(`SELECT monthly_allowance_usd, credits_usd FROM platform_users WHERE id = $1`, [testUserId]);
    expect(parseFloat(u.rows[0].monthly_allowance_usd)).toBeCloseTo(1, 4); // 0 + 1 (monthly portion)
    expect(parseFloat(u.rows[0].credits_usd)).toBeCloseTo(10, 4); // 8 + 2 (topup portion)
  });
});
