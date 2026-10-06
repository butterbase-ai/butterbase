import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import pg from 'pg';
import { config } from '../config.js';
import { grantLease } from './lease-service.js';
import { reclaimExpiredLeases } from './lease-reclaim.js';

const describeDb = process.env.RUN_DB_TESTS ? describe : describe.skip;

describeDb('reclaimExpiredLeases', () => {
  let pool: pg.Pool;
  let testUserId: string;
  let testOrgId: string;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: config.controlDb.url });

    const suffix = crypto.randomUUID();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const tmpId = crypto.randomUUID();
      const orgResult = await client.query<{ id: string }>(
        `INSERT INTO organizations (owner_id, name, personal, plan_id, credits_usd, auto_refill_enabled, account_status)
         VALUES ($1, 'test org', true, 'playground', 0, false, 'active')
         RETURNING id`,
        [tmpId],
      );
      testOrgId = orgResult.rows[0].id;
      const userResult = await client.query<{ id: string }>(
        `INSERT INTO platform_users (id, email, cognito_sub, personal_organization_id)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [tmpId, `reclaim-test-${suffix}@example.com`, `reclaim-test-sub-${suffix}`, testOrgId],
      );
      testUserId = userResult.rows[0].id;
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    await pool.query('DELETE FROM credit_leases WHERE organization_id = $1', [testOrgId]);
    await pool.query('DELETE FROM platform_users WHERE id = $1', [testUserId]);
    await pool.query('DELETE FROM organizations WHERE id = $1', [testOrgId]);
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM credit_leases WHERE organization_id = $1', [testOrgId]);
    await pool.query(
      `UPDATE organizations SET monthly_allowance_usd = 0, credits_usd = 5.00, credit_floor_usd = 0 WHERE id = $1`,
      [testOrgId],
    );
  });

  it('reclaims an expired active lease and credits balance', async () => {
    const grant = await grantLease(pool, { userId: testUserId, organizationId: testOrgId, region: 'us-east-1', amountUsd: 1, ttlSeconds: 300 });
    await pool.query(`UPDATE credit_leases SET expires_at = now() - interval '60 seconds' WHERE lease_id = $1`, [grant.leaseId]);
    const r = await reclaimExpiredLeases(pool, 30);
    expect(r.reclaimed).toBe(1);
    const lease = await pool.query(`SELECT status FROM credit_leases WHERE lease_id = $1`, [grant.leaseId]);
    expect(lease.rows[0].status).toBe('reclaimed');
    const u = await pool.query(`SELECT credits_usd FROM organizations WHERE id = $1`, [testOrgId]);
    expect(parseFloat(u.rows[0].credits_usd)).toBeCloseTo(5, 2);
  });

  it('does not reclaim leases within the grace window', async () => {
    await grantLease(pool, { userId: testUserId, organizationId: testOrgId, region: 'us-east-1', amountUsd: 1, ttlSeconds: 1 });
    const r = await reclaimExpiredLeases(pool, 30);
    expect(r.reclaimed).toBe(0);
  });

  it('skips already-reclaimed leases', async () => {
    const grant = await grantLease(pool, { userId: testUserId, organizationId: testOrgId, region: 'us-east-1', amountUsd: 1, ttlSeconds: 300 });
    await pool.query(`UPDATE credit_leases SET expires_at = now() - interval '60 seconds', status = 'reclaimed' WHERE lease_id = $1`, [grant.leaseId]);
    const r = await reclaimExpiredLeases(pool, 30);
    expect(r.reclaimed).toBe(0);
  });
});

describeDb('reclaimExpiredLeases — split pools', () => {
  let pool: pg.Pool;
  let testUserId: string;
  let testOrgId: string;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: config.controlDb.url });

    const suffix = crypto.randomUUID();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const tmpId = crypto.randomUUID();
      const orgResult = await client.query<{ id: string }>(
        `INSERT INTO organizations (owner_id, name, personal, plan_id, credits_usd, auto_refill_enabled, account_status)
         VALUES ($1, 'test org', true, 'playground', 0, false, 'active')
         RETURNING id`,
        [tmpId],
      );
      testOrgId = orgResult.rows[0].id;
      const userResult = await client.query<{ id: string }>(
        `INSERT INTO platform_users (id, email, cognito_sub, personal_organization_id)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [tmpId, `reclaim-split-test-${suffix}@example.com`, `reclaim-split-test-sub-${suffix}`, testOrgId],
      );
      testUserId = userResult.rows[0].id;
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    await pool.query('DELETE FROM credit_leases WHERE organization_id = $1', [testOrgId]);
    await pool.query('DELETE FROM platform_users WHERE id = $1', [testUserId]);
    await pool.query('DELETE FROM organizations WHERE id = $1', [testOrgId]);
    await pool.end();
  });

  const readPools = async (orgId: string) => {
    const u = await pool.query(
      `SELECT monthly_allowance_usd, credits_usd FROM organizations WHERE id = $1`,
      [orgId],
    );
    return u.rows[0];
  };
  const seedPools = async (orgId: string, monthly: number, credits: number) => {
    await pool.query(
      `UPDATE organizations SET monthly_allowance_usd = $1, credits_usd = $2, credit_floor_usd = 0 WHERE id = $3`,
      [monthly, credits, orgId],
    );
  };

  beforeEach(async () => {
    await pool.query('DELETE FROM credit_leases WHERE organization_id = $1', [testOrgId]);
  });

  it('refunds monthly-only lease back to monthly_allowance', async () => {
    await seedPools(testOrgId, 10, 0);
    const grant = await grantLease(pool, { userId: testUserId, organizationId: testOrgId, region: 'test', amountUsd: 4, ttlSeconds: 60 });
    if (!grant.leaseId) throw new Error('grant failed');
    // After grant: monthly = 6, credits = 0.
    await pool.query(`UPDATE credit_leases SET expires_at = now() - interval '1 minute' WHERE lease_id = $1`, [grant.leaseId]);
    const result = await reclaimExpiredLeases(pool, 0);
    expect(result.reclaimed).toBeGreaterThanOrEqual(1);
    const u = await readPools(testOrgId);
    expect(parseFloat(u.monthly_allowance_usd)).toBeCloseTo(10, 4); // 6 + 4
    expect(parseFloat(u.credits_usd)).toBeCloseTo(0, 4);
  });

  it('refunds topup-only lease back to credits_usd', async () => {
    await seedPools(testOrgId, 0, 10);
    const grant = await grantLease(pool, { userId: testUserId, organizationId: testOrgId, region: 'test', amountUsd: 4, ttlSeconds: 60 });
    if (!grant.leaseId) throw new Error('grant failed');
    await pool.query(`UPDATE credit_leases SET expires_at = now() - interval '1 minute' WHERE lease_id = $1`, [grant.leaseId]);
    await reclaimExpiredLeases(pool, 0);
    const u = await readPools(testOrgId);
    expect(parseFloat(u.monthly_allowance_usd)).toBeCloseTo(0, 4);
    expect(parseFloat(u.credits_usd)).toBeCloseTo(10, 4);
  });

  it('refunds split lease back to both pools by original portions', async () => {
    await seedPools(testOrgId, 1, 10);
    const grant = await grantLease(pool, { userId: testUserId, organizationId: testOrgId, region: 'test', amountUsd: 3, ttlSeconds: 60 });
    if (!grant.leaseId) throw new Error('grant failed');
    // After grant: monthly = 0 (was 1, drew 1), credits = 8 (was 10, drew 2 from split).
    await pool.query(`UPDATE credit_leases SET expires_at = now() - interval '1 minute' WHERE lease_id = $1`, [grant.leaseId]);
    await reclaimExpiredLeases(pool, 0);
    const u = await readPools(testOrgId);
    expect(parseFloat(u.monthly_allowance_usd)).toBeCloseTo(1, 4); // 0 + 1 (monthly portion)
    expect(parseFloat(u.credits_usd)).toBeCloseTo(10, 4); // 8 + 2 (topup portion)
  });
});

describeDb('reclaimExpiredLeases — nominal vs real leases', () => {
  let pool: pg.Pool;
  let testUserId: string;
  let testOrgId: string;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: config.controlDb.url });

    const suffix = crypto.randomUUID();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const tmpId = crypto.randomUUID();
      const orgResult = await client.query<{ id: string }>(
        `INSERT INTO organizations (owner_id, name, personal, plan_id, credits_usd, auto_refill_enabled, account_status, credit_floor_usd)
         VALUES ($1, 'reclaim-test-org', true, 'playground', 10, false, 'active', -25)
         RETURNING id`,
        [tmpId],
      );
      testOrgId = orgResult.rows[0].id;
      const userResult = await client.query<{ id: string }>(
        `INSERT INTO platform_users (id, email, cognito_sub, personal_organization_id)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [tmpId, `reclaim-small-test-${suffix}@example.com`, `reclaim-small-test-sub-${suffix}`, testOrgId],
      );
      testUserId = userResult.rows[0].id;
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    await pool.query('DELETE FROM credit_leases WHERE organization_id = $1', [testOrgId]);
    await pool.query('DELETE FROM platform_users WHERE id = $1', [testUserId]);
    await pool.query('DELETE FROM organizations WHERE id = $1', [testOrgId]);
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM credit_leases WHERE organization_id = $1', [testOrgId]);
    await pool.query(
      `UPDATE organizations SET monthly_allowance_usd = 0, credits_usd = 10, credit_floor_usd = -25 WHERE id = $1`,
      [testOrgId],
    );
  });

  const expire = async (leaseId: string | null) => {
    await pool.query(
      `UPDATE credit_leases SET expires_at = now() - interval '1 hour' WHERE lease_id = $1`,
      [leaseId],
    );
  };
  const statusOf = async (leaseId: string | null) => {
    const st = await pool.query<{ status: string }>(
      `SELECT status FROM credit_leases WHERE lease_id = $1`, [leaseId],
    );
    return st.rows[0].status;
  };
  const credits = async () => {
    const u = await pool.query<{ c: string }>(
      `SELECT credits_usd AS c FROM organizations WHERE id = $1`, [testOrgId],
    );
    return parseFloat(u.rows[0].c);
  };

  // The decision is per lease, not per flag — this is what makes the flag safe
  // to flip in either direction while leases are in flight.
  it('marks a nominal (MIN_LEASE_USD) expired lease abandoned without refunding', async () => {
    const g = await grantLease(pool, {
      userId: testUserId,
      organizationId: testOrgId,
      region: 'us-east-1',
      amountUsd: 0.0001,
      ttlSeconds: 1,
      allowFloor: true,
    });
    await expire(g.leaseId);

    const before = await credits();
    const r = await reclaimExpiredLeases(pool, 0);
    expect(await credits()).toBeCloseTo(before, 4); // no refund
    expect(await statusOf(g.leaseId)).toBe('abandoned');
    expect(r.abandoned).toBe(1);
    expect(r.reclaimed).toBe(0);
    expect(r.totalCreditedUsd).toBeCloseTo(0, 4);
  });

  it('refunds a real reservation and abandons a nominal one in the same sweep', async () => {
    // A legacy-style real reservation, e.g. a video job that pre-debited $3.60.
    const real = await grantLease(pool, {
      userId: testUserId, organizationId: testOrgId, region: 'us-east-1',
      amountUsd: 3.6, ttlSeconds: 1,
    });
    // And a reserve-small nominal hold.
    const nominal = await grantLease(pool, {
      userId: testUserId, organizationId: testOrgId, region: 'us-east-1',
      amountUsd: 0.0001, ttlSeconds: 1, allowFloor: true,
    });
    await expire(real.leaseId);
    await expire(nominal.leaseId);

    // After both grants: 10 - 3.6 - 0.0001 = 6.3999.
    expect(await credits()).toBeCloseTo(6.3999, 4);

    const r = await reclaimExpiredLeases(pool, 0);

    // Only the real reservation is refunded — the nominal one is not.
    expect(await credits()).toBeCloseTo(9.9999, 4);
    expect(await statusOf(real.leaseId)).toBe('reclaimed');
    expect(await statusOf(nominal.leaseId)).toBe('abandoned');
    expect(r.reclaimed).toBe(1);
    expect(r.abandoned).toBe(1);
    expect(r.totalCreditedUsd).toBeCloseTo(3.6, 4);
  });
});
