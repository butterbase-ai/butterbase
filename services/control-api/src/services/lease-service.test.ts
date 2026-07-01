import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { grantLease, settleLease, GrantResult } from './lease-service.js';

const PLATFORM_URL = process.env.NEON_PLATFORM_PRIMARY_URL
  ?? 'postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control';

let pool: pg.Pool;
let testUserId: string;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: PLATFORM_URL });
});
afterAll(async () => { await pool.end(); });

beforeEach(async () => {
  // Look up the previous user id before deleting so we can clean up the org after.
  // platform_users.personal_organization_id FKs organizations, so the user row must
  // be deleted before the org row (post-Plan-05 migration 076).
  const prev = await pool.query(
    `SELECT id FROM platform_users WHERE email = 'lease-test@example.com'`,
  );
  const prevUserId = prev.rows[0]?.id as string | undefined;

  await pool.query(`DELETE FROM credit_leases WHERE user_id = (SELECT id FROM platform_users WHERE email = 'lease-test@example.com')`);
  await pool.query(`DELETE FROM platform_users WHERE email = 'lease-test@example.com'`);
  if (prevUserId) {
    await pool.query(`DELETE FROM organizations WHERE owner_id = $1`, [prevUserId]);
  }

  // Generate user id upfront so we can create the personal org before the user row
  // (platform_users.personal_organization_id is NOT NULL post-Plan-05 migration 076).
  const userId = (await pool.query(`SELECT gen_random_uuid() AS id`)).rows[0].id as string;
  const orgResult = await pool.query(
    `INSERT INTO organizations (
        owner_id, name, personal,
        plan_id, credits_usd, auto_refill_enabled, account_status
     )
     VALUES ($1, $2, true, 'playground', 5.00, false, 'active')
     RETURNING id`,
    [userId, "lease-test's org"],
  );
  const orgId = orgResult.rows[0].id as string;
  await pool.query(
    `INSERT INTO platform_users (id, email, account_status, plan_id, credits_usd, personal_organization_id)
     VALUES ($1, 'lease-test@example.com', 'active', 'playground', 5.00, $2)`,
    [userId, orgId],
  );
  testUserId = userId;
});

describe('grantLease', () => {
  it('decrements credits_usd by the requested amount and writes a lease', async () => {
    const r = await grantLease(pool, { userId: testUserId, region: 'us-east-1', amountUsd: 1, ttlSeconds: 300 });
    expect(r.amountGranted).toBe(1);
    expect(r.leaseId).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const u = await pool.query(`SELECT credits_usd FROM platform_users WHERE id = $1`, [testUserId]);
    expect(parseFloat(u.rows[0].credits_usd)).toBeCloseTo(4, 2);

    const l = await pool.query(`SELECT * FROM credit_leases WHERE user_id = $1`, [testUserId]);
    expect(l.rows.length).toBe(1);
    expect(l.rows[0].status).toBe('active');
    expect(l.rows[0].region).toBe('us-east-1');
  });

  it('grants a partial lease when balance is below requested amount', async () => {
    await pool.query(`UPDATE platform_users SET credits_usd = 0.30 WHERE id = $1`, [testUserId]);
    const r = await grantLease(pool, { userId: testUserId, region: 'us-east-1', amountUsd: 1, ttlSeconds: 300 });
    expect(r.amountGranted).toBeCloseTo(0.30, 2);
    const u = await pool.query(`SELECT credits_usd FROM platform_users WHERE id = $1`, [testUserId]);
    expect(parseFloat(u.rows[0].credits_usd)).toBeCloseTo(0, 2);
  });

  it('grants zero amount and writes no lease row when balance is zero', async () => {
    await pool.query(`UPDATE platform_users SET credits_usd = 0 WHERE id = $1`, [testUserId]);
    const r = await grantLease(pool, { userId: testUserId, region: 'us-east-1', amountUsd: 1, ttlSeconds: 300 });
    expect(r.amountGranted).toBe(0);
    expect(r.leaseId).toBeNull();
    const l = await pool.query(`SELECT count(*)::int AS c FROM credit_leases WHERE user_id = $1`, [testUserId]);
    expect(l.rows[0].c).toBe(0);
  });

  it('rejects non-positive amount', async () => {
    await expect(grantLease(pool, { userId: testUserId, region: 'us-east-1', amountUsd: 0, ttlSeconds: 300 })).rejects.toThrow();
    await expect(grantLease(pool, { userId: testUserId, region: 'us-east-1', amountUsd: -1, ttlSeconds: 300 })).rejects.toThrow();
  });
});

describe('grantLease — split pools', () => {
  it('draws from monthly when monthly covers the full amount', async () => {
    await pool.query(
      `UPDATE platform_users SET monthly_allowance_usd = 10, credits_usd = 5 WHERE id = $1`,
      [testUserId]
    );
    const r = await grantLease(pool, { userId: testUserId, region: 'test', amountUsd: 4, ttlSeconds: 60 });
    expect(r.amountGranted).toBeCloseTo(4, 4);
    const u = await pool.query(`SELECT monthly_allowance_usd, credits_usd FROM platform_users WHERE id = $1`, [testUserId]);
    expect(parseFloat(u.rows[0].monthly_allowance_usd)).toBeCloseTo(6, 4);
    expect(parseFloat(u.rows[0].credits_usd)).toBeCloseTo(5, 4);
    const l = await pool.query(`SELECT source_pool, topup_amount_usd FROM credit_leases WHERE lease_id = $1`, [r.leaseId]);
    expect(l.rows[0].source_pool).toBe('monthly');
    expect(l.rows[0].topup_amount_usd).toBeNull();
  });

  it('draws from topup when monthly is empty', async () => {
    await pool.query(
      `UPDATE platform_users SET monthly_allowance_usd = 0, credits_usd = 5 WHERE id = $1`,
      [testUserId]
    );
    const r = await grantLease(pool, { userId: testUserId, region: 'test', amountUsd: 2, ttlSeconds: 60 });
    expect(r.amountGranted).toBeCloseTo(2, 4);
    const u = await pool.query(`SELECT credits_usd FROM platform_users WHERE id = $1`, [testUserId]);
    expect(parseFloat(u.rows[0].credits_usd)).toBeCloseTo(3, 4);
    const l = await pool.query(`SELECT source_pool FROM credit_leases WHERE lease_id = $1`, [r.leaseId]);
    expect(l.rows[0].source_pool).toBe('topup');
  });

  it('splits when monthly is insufficient but combined covers', async () => {
    await pool.query(
      `UPDATE platform_users SET monthly_allowance_usd = 1, credits_usd = 5 WHERE id = $1`,
      [testUserId]
    );
    const r = await grantLease(pool, { userId: testUserId, region: 'test', amountUsd: 3, ttlSeconds: 60 });
    expect(r.amountGranted).toBeCloseTo(3, 4);
    const u = await pool.query(`SELECT monthly_allowance_usd, credits_usd FROM platform_users WHERE id = $1`, [testUserId]);
    expect(parseFloat(u.rows[0].monthly_allowance_usd)).toBeCloseTo(0, 4);
    expect(parseFloat(u.rows[0].credits_usd)).toBeCloseTo(3, 4); // 5 - 2
    const l = await pool.query(`SELECT source_pool, amount_usd, topup_amount_usd FROM credit_leases WHERE lease_id = $1`, [r.leaseId]);
    expect(l.rows[0].source_pool).toBe('split');
    expect(parseFloat(l.rows[0].amount_usd)).toBeCloseTo(3, 4);
    expect(parseFloat(l.rows[0].topup_amount_usd)).toBeCloseTo(2, 4);
  });

  it('returns leaseId=null when both pools empty', async () => {
    await pool.query(
      `UPDATE platform_users SET monthly_allowance_usd = 0, credits_usd = 0 WHERE id = $1`,
      [testUserId]
    );
    const r = await grantLease(pool, { userId: testUserId, region: 'test', amountUsd: 1, ttlSeconds: 60 });
    expect(r.leaseId).toBeNull();
    expect(r.amountGranted).toBe(0);
  });

  it('partial grant: requests more than combined; grants partially', async () => {
    await pool.query(
      `UPDATE platform_users SET monthly_allowance_usd = 1, credits_usd = 1 WHERE id = $1`,
      [testUserId]
    );
    const r = await grantLease(pool, { userId: testUserId, region: 'test', amountUsd: 5, ttlSeconds: 60 });
    expect(r.amountGranted).toBeCloseTo(2, 4);
    expect(r.leaseId).toBeTruthy();
  });
});

describe('settleLease', () => {
  it('settles a lease, marks it settled, and refunds the unspent portion', async () => {
    await pool.query(
      `UPDATE platform_users SET credits_usd = 10 WHERE id = $1`,
      [testUserId]
    );
    const grant = await grantLease(pool, {
      userId: testUserId, region: 'test', amountUsd: 4, ttlSeconds: 60,
    });
    if (!grant.leaseId) throw new Error('grant failed');

    const res = await settleLease(pool, { leaseId: grant.leaseId, actualUsd: 1.5 });

    expect(res.refundedUsd).toBeCloseTo(2.5, 2);
    const u = await pool.query(`SELECT credits_usd FROM platform_users WHERE id = $1`, [testUserId]);
    expect(parseFloat(u.rows[0].credits_usd)).toBeCloseTo(8.5, 2);

    const l = await pool.query(
      `SELECT status, settled_amount_usd FROM credit_leases WHERE lease_id = $1`,
      [grant.leaseId]
    );
    expect(l.rows[0].status).toBe('settled');
    expect(parseFloat(l.rows[0].settled_amount_usd)).toBeCloseTo(1.5, 2);
  });

  it('is idempotent: re-settle returns 0 refund and does not double-credit', async () => {
    await pool.query(`UPDATE platform_users SET credits_usd = 10 WHERE id = $1`, [testUserId]);
    const grant = await grantLease(pool, { userId: testUserId, region: 'test', amountUsd: 4, ttlSeconds: 60 });
    if (!grant.leaseId) throw new Error('grant failed');
    await settleLease(pool, { leaseId: grant.leaseId, actualUsd: 1 });

    const second = await settleLease(pool, { leaseId: grant.leaseId, actualUsd: 1 });

    expect(second.refundedUsd).toBe(0);
    const u = await pool.query(`SELECT credits_usd FROM platform_users WHERE id = $1`, [testUserId]);
    expect(parseFloat(u.rows[0].credits_usd)).toBeCloseTo(9, 2);
  });

  it('clamps actualUsd above the granted amount (no over-charge)', async () => {
    await pool.query(`UPDATE platform_users SET credits_usd = 10 WHERE id = $1`, [testUserId]);
    const grant = await grantLease(pool, { userId: testUserId, region: 'test', amountUsd: 2, ttlSeconds: 60 });
    if (!grant.leaseId) throw new Error('grant failed');

    const res = await settleLease(pool, { leaseId: grant.leaseId, actualUsd: 5 });

    expect(res.refundedUsd).toBe(0);
    const l = await pool.query(`SELECT settled_amount_usd FROM credit_leases WHERE lease_id = $1`, [grant.leaseId]);
    expect(parseFloat(l.rows[0].settled_amount_usd)).toBeCloseTo(2, 2);
  });

  it('clamps actualUsd below 0 (no negative charge)', async () => {
    await pool.query(`UPDATE platform_users SET credits_usd = 10 WHERE id = $1`, [testUserId]);
    const grant = await grantLease(pool, { userId: testUserId, region: 'test', amountUsd: 3, ttlSeconds: 60 });
    if (!grant.leaseId) throw new Error('grant failed');

    const res = await settleLease(pool, { leaseId: grant.leaseId, actualUsd: -1 });

    expect(res.refundedUsd).toBeCloseTo(3, 2);
    const u = await pool.query(`SELECT credits_usd FROM platform_users WHERE id = $1`, [testUserId]);
    expect(parseFloat(u.rows[0].credits_usd)).toBeCloseTo(10, 2);
  });

  it('throws when the lease does not exist', async () => {
    await expect(
      settleLease(pool, { leaseId: '00000000-0000-0000-0000-000000000000', actualUsd: 1 })
    ).rejects.toThrow(/lease not found/);
  });
});

describe('settleLease — split pools', () => {
  it('refunds monthly-only lease back to monthly_allowance', async () => {
    await pool.query(`UPDATE platform_users SET monthly_allowance_usd = 10, credits_usd = 0 WHERE id = $1`, [testUserId]);
    const grant = await grantLease(pool, { userId: testUserId, region: 'test', amountUsd: 4, ttlSeconds: 60 });
    if (!grant.leaseId) throw new Error('grant failed');
    const r = await settleLease(pool, { leaseId: grant.leaseId, actualUsd: 1 });
    expect(r.refundedUsd).toBeCloseTo(3, 4);
    const u = await pool.query(`SELECT monthly_allowance_usd, credits_usd FROM platform_users WHERE id = $1`, [testUserId]);
    expect(parseFloat(u.rows[0].monthly_allowance_usd)).toBeCloseTo(9, 4);
    expect(parseFloat(u.rows[0].credits_usd)).toBeCloseTo(0, 4);
  });

  it('refunds topup-only lease back to credits_usd', async () => {
    await pool.query(`UPDATE platform_users SET monthly_allowance_usd = 0, credits_usd = 10 WHERE id = $1`, [testUserId]);
    const grant = await grantLease(pool, { userId: testUserId, region: 'test', amountUsd: 4, ttlSeconds: 60 });
    if (!grant.leaseId) throw new Error('grant failed');
    const r = await settleLease(pool, { leaseId: grant.leaseId, actualUsd: 1 });
    expect(r.refundedUsd).toBeCloseTo(3, 4);
    const u = await pool.query(`SELECT monthly_allowance_usd, credits_usd FROM platform_users WHERE id = $1`, [testUserId]);
    expect(parseFloat(u.rows[0].monthly_allowance_usd)).toBeCloseTo(0, 4);
    expect(parseFloat(u.rows[0].credits_usd)).toBeCloseTo(9, 4);
  });

  it('split-pool refund pro-rates back to both pools', async () => {
    // grant: monthly=1, topup=2, total=3. After grant: monthly=0, credits=8 (was 10).
    // settle actual=0.6 → refund=2.4. monthlyPortion=1, topupPortion=2 of granted=3.
    // monthlyRefund = 2.4 * 1 / 3 = 0.8 → 0.8 to monthly
    // topupRefund   = 2.4 - 0.8 = 1.6 → 1.6 to credits
    await pool.query(`UPDATE platform_users SET monthly_allowance_usd = 1, credits_usd = 10 WHERE id = $1`, [testUserId]);
    const grant = await grantLease(pool, { userId: testUserId, region: 'test', amountUsd: 3, ttlSeconds: 60 });
    if (!grant.leaseId) throw new Error('grant failed');
    const r = await settleLease(pool, { leaseId: grant.leaseId, actualUsd: 0.6 });
    expect(r.refundedUsd).toBeCloseTo(2.4, 4);
    const u = await pool.query(`SELECT monthly_allowance_usd, credits_usd FROM platform_users WHERE id = $1`, [testUserId]);
    expect(parseFloat(u.rows[0].monthly_allowance_usd)).toBeCloseTo(0.8, 3);
    expect(parseFloat(u.rows[0].credits_usd)).toBeCloseTo(9.6, 3); // 8 + 1.6
  });

  it('full refund on actual=0 returns full granted amount to source pool', async () => {
    await pool.query(`UPDATE platform_users SET monthly_allowance_usd = 10, credits_usd = 5 WHERE id = $1`, [testUserId]);
    const grant = await grantLease(pool, { userId: testUserId, region: 'test', amountUsd: 4, ttlSeconds: 60 });
    if (!grant.leaseId) throw new Error('grant failed');
    const r = await settleLease(pool, { leaseId: grant.leaseId, actualUsd: 0 });
    expect(r.refundedUsd).toBeCloseTo(4, 4);
    const u = await pool.query(`SELECT monthly_allowance_usd, credits_usd FROM platform_users WHERE id = $1`, [testUserId]);
    expect(parseFloat(u.rows[0].monthly_allowance_usd)).toBeCloseTo(10, 4); // full refund to monthly
    expect(parseFloat(u.rows[0].credits_usd)).toBeCloseTo(5, 4);
  });
});
