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
  // Look up the previous user id before deleting so we can clean up the org after.
  // platform_users.personal_organization_id FKs organizations, so the user row must
  // be deleted before the org row (post-Plan-05 migration 076).
  const prev = await pool.query(
    `SELECT id FROM platform_users WHERE email = 'reclaim-test@example.com'`,
  );
  const prevUserId = prev.rows[0]?.id as string | undefined;

  await pool.query(`DELETE FROM credit_leases WHERE user_id = (SELECT id FROM platform_users WHERE email = 'reclaim-test@example.com')`);
  await pool.query(`DELETE FROM platform_users WHERE email = 'reclaim-test@example.com'`);
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
    [userId, "reclaim-test's org"],
  );
  const orgId = orgResult.rows[0].id as string;
  // Post-migration 079 dropped billing cols from platform_users; billing on orgs.
  await pool.query(
    `INSERT INTO platform_users (id, email, personal_organization_id)
     VALUES ($1, 'reclaim-test@example.com', $2)`,
    [userId, orgId],
  );
  testUserId = userId;
});

describe('reclaimExpiredLeases', () => {
  it('reclaims an expired active lease and credits balance', async () => {
    const grant = await grantLease(pool, { userId: testUserId, region: 'us-east-1', amountUsd: 1, ttlSeconds: 300 });
    await pool.query(`UPDATE credit_leases SET expires_at = now() - interval '60 seconds' WHERE lease_id = $1`, [grant.leaseId]);
    const r = await reclaimExpiredLeases(pool, 30);
    expect(r.reclaimed).toBe(1);
    const lease = await pool.query(`SELECT status FROM credit_leases WHERE lease_id = $1`, [grant.leaseId]);
    expect(lease.rows[0].status).toBe('reclaimed');
    // Post-Plan-07: credits_usd lives on organizations. Read via personal_org.
    const u = await pool.query(
      `SELECT o.credits_usd FROM organizations o
       JOIN platform_users pu ON pu.personal_organization_id = o.id
       WHERE pu.id = $1`,
      [testUserId],
    );
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
  // Post-Plan-07: monthly_allowance_usd stays on platform_users; credits_usd
  // moved to organizations. Each test seeds via TWO UPDATEs and reads via JOIN.
  const readPools = async (userId: string) => {
    const u = await pool.query(
      `SELECT pu.monthly_allowance_usd, o.credits_usd
       FROM platform_users pu
       JOIN organizations o ON o.id = pu.personal_organization_id
       WHERE pu.id = $1`,
      [userId],
    );
    return u.rows[0];
  };
  const seedPools = async (userId: string, monthly: number, credits: number) => {
    await pool.query(`UPDATE platform_users SET monthly_allowance_usd = $1 WHERE id = $2`, [monthly, userId]);
    await pool.query(
      `UPDATE organizations SET credits_usd = $1
       WHERE id = (SELECT personal_organization_id FROM platform_users WHERE id = $2)`,
      [credits, userId],
    );
  };

  it('refunds monthly-only lease back to monthly_allowance', async () => {
    await seedPools(testUserId, 10, 0);
    const grant = await grantLease(pool, { userId: testUserId, region: 'test', amountUsd: 4, ttlSeconds: 60 });
    if (!grant.leaseId) throw new Error('grant failed');
    // After grant: monthly = 6, credits = 0.
    await pool.query(`UPDATE credit_leases SET expires_at = now() - interval '1 minute' WHERE lease_id = $1`, [grant.leaseId]);
    const result = await reclaimExpiredLeases(pool, 0);
    expect(result.reclaimed).toBeGreaterThanOrEqual(1);
    const u = await readPools(testUserId);
    expect(parseFloat(u.monthly_allowance_usd)).toBeCloseTo(10, 4); // 6 + 4
    expect(parseFloat(u.credits_usd)).toBeCloseTo(0, 4);
  });

  it('refunds topup-only lease back to credits_usd', async () => {
    await seedPools(testUserId, 0, 10);
    const grant = await grantLease(pool, { userId: testUserId, region: 'test', amountUsd: 4, ttlSeconds: 60 });
    if (!grant.leaseId) throw new Error('grant failed');
    await pool.query(`UPDATE credit_leases SET expires_at = now() - interval '1 minute' WHERE lease_id = $1`, [grant.leaseId]);
    await reclaimExpiredLeases(pool, 0);
    const u = await readPools(testUserId);
    expect(parseFloat(u.monthly_allowance_usd)).toBeCloseTo(0, 4);
    expect(parseFloat(u.credits_usd)).toBeCloseTo(10, 4);
  });

  it('refunds split lease back to both pools by original portions', async () => {
    await seedPools(testUserId, 1, 10);
    const grant = await grantLease(pool, { userId: testUserId, region: 'test', amountUsd: 3, ttlSeconds: 60 });
    if (!grant.leaseId) throw new Error('grant failed');
    // After grant: monthly = 0 (was 1, drew 1), credits = 8 (was 10, drew 2 from split).
    await pool.query(`UPDATE credit_leases SET expires_at = now() - interval '1 minute' WHERE lease_id = $1`, [grant.leaseId]);
    await reclaimExpiredLeases(pool, 0);
    const u = await readPools(testUserId);
    expect(parseFloat(u.monthly_allowance_usd)).toBeCloseTo(1, 4); // 0 + 1 (monthly portion)
    expect(parseFloat(u.credits_usd)).toBeCloseTo(10, 4); // 8 + 2 (topup portion)
  });
});
