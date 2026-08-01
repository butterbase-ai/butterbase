import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import pg from 'pg';
import { grantLease, settleLease } from './lease-service.js';
import { config } from '../config.js';

const describeDb = process.env.RUN_DB_TESTS ? describe : describe.skip;

let pool: pg.Pool;
let orgId: string;
let userId: string;

async function setBalance(monthly: number, topup: number, floor: number) {
  await pool.query(
    `UPDATE organizations
       SET monthly_allowance_usd = $1, credits_usd = $2, credit_floor_usd = $3
     WHERE id = $4`,
    [monthly, topup, floor, orgId],
  );
}

async function balances() {
  const r = await pool.query<{ m: string; c: string }>(
    `SELECT monthly_allowance_usd AS m, credits_usd AS c FROM organizations WHERE id = $1`,
    [orgId],
  );
  return { monthly: parseFloat(r.rows[0].m), topup: parseFloat(r.rows[0].c) };
}

describeDb('grantLease — floor semantics', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: config.controlDb.url });

    // Create test user with a personal org — organizations.owner_id and
    // platform_users.personal_organization_id are mutually NOT NULL FKs, so
    // pre-generate a UUID and insert both rows in one transaction (see
    // src/__tests__/api-key-service.test.ts:21-39 for the established
    // pattern). Randomize the email so a crashed prior run (afterAll didn't
    // fire) doesn't poison reruns via the unique constraint on
    // platform_users.email.
    const suffix = crypto.randomUUID();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const tmpId = crypto.randomUUID();
      const orgResult = await client.query<{ id: string }>(
        `INSERT INTO organizations (owner_id, name, personal, plan_id, credits_usd, auto_refill_enabled, account_status)
         VALUES ($1, 'floor-test-org', true, 'playground', 0, false, 'active')
         RETURNING id`,
        [tmpId],
      );
      orgId = orgResult.rows[0].id;
      const userResult = await client.query<{ id: string }>(
        `INSERT INTO platform_users (id, email, personal_organization_id)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [tmpId, `floor-test-${suffix}@example.com`, orgId],
      );
      userId = userResult.rows[0].id;
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM credit_leases WHERE organization_id = $1`, [orgId]);
    await pool.query(`DELETE FROM platform_users WHERE id = $1`, [userId]);
    await pool.query(`DELETE FROM organizations WHERE id = $1`, [orgId]);
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM credit_leases WHERE organization_id = $1`, [orgId]);
  });

  it('grants the full amount when balance is above the floor, even if balance is short', async () => {
    await setBalance(0, 0.5, -25);
    const res = await grantLease(pool, {
      userId, organizationId: orgId, region: 'us-east-1',
      amountUsd: 3, ttlSeconds: 60, allowFloor: true,
    });
    expect(res.leaseId).not.toBeNull();
    expect(res.amountGranted).toBe(3);           // full amount, NOT clamped to 0.5
    const b = await balances();
    expect(b.topup).toBeCloseTo(-2.5, 4);        // credits_usd absorbs the overdraft
    expect(b.monthly).toBe(0);
  });

  it('refuses when balance is already below the floor', async () => {
    await setBalance(0, -30, -25);
    const res = await grantLease(pool, {
      userId, organizationId: orgId, region: 'us-east-1',
      amountUsd: 0.0001, ttlSeconds: 60, allowFloor: true,
    });
    expect(res.leaseId).toBeNull();
    expect(res.balanceUsd).toBeCloseTo(-30, 4);
    expect(res.floorUsd).toBeCloseTo(-25, 4);
  });

  it('drains monthly before topup and never drives monthly negative', async () => {
    await setBalance(1, 5, -25);
    await grantLease(pool, {
      userId, organizationId: orgId, region: 'us-east-1',
      amountUsd: 3, ttlSeconds: 60, allowFloor: true,
    });
    const b = await balances();
    expect(b.monthly).toBe(0);                   // drained to zero, not to -2
    expect(b.topup).toBeCloseTo(3, 4);           // remaining 2 came from topup
  });

  it('legacy path (allowFloor absent) still partial-grants', async () => {
    await setBalance(0, 0.5, -25);
    const res = await grantLease(pool, {
      userId, organizationId: orgId, region: 'us-east-1',
      amountUsd: 3, ttlSeconds: 60,
    });
    expect(res.amountGranted).toBeCloseTo(0.5, 4);
  });

  it('rejects non-positive amountUsd', async () => {
    await expect(
      grantLease(pool, { userId, organizationId: orgId, region: 'us-east-1', amountUsd: 0, ttlSeconds: 60 })
    ).rejects.toThrow();
  });

  // Back-ported from the pre-existing (dead, pre-multi-org) suite this file
  // replaced. These assert the classification/refund-routing behavior that
  // this diff's rounding change (`topupDraw = +(...).toFixed(4)`) touches,
  // and that Task 4's settleLease rewrite will need as a regression guard.
  // Written against CURRENT settleLease semantics (clamping) — not Task 4's
  // future behavior.
  describe('grantLease — source pool attribution', () => {
    it('draws from monthly when monthly covers the full amount', async () => {
      await setBalance(10, 5, -25);
      const r = await grantLease(pool, {
        userId, organizationId: orgId, region: 'test', amountUsd: 4, ttlSeconds: 60,
      });
      expect(r.amountGranted).toBeCloseTo(4, 4);
      const b = await balances();
      expect(b.monthly).toBeCloseTo(6, 4);
      expect(b.topup).toBeCloseTo(5, 4);
      const l = await pool.query(
        `SELECT source_pool, topup_amount_usd FROM credit_leases WHERE lease_id = $1`,
        [r.leaseId],
      );
      expect(l.rows[0].source_pool).toBe('monthly');
      expect(l.rows[0].topup_amount_usd).toBeNull();
    });

    it('draws from topup when monthly is empty', async () => {
      await setBalance(0, 5, -25);
      const r = await grantLease(pool, {
        userId, organizationId: orgId, region: 'test', amountUsd: 2, ttlSeconds: 60,
      });
      expect(r.amountGranted).toBeCloseTo(2, 4);
      const b = await balances();
      expect(b.topup).toBeCloseTo(3, 4);
      const l = await pool.query(
        `SELECT source_pool FROM credit_leases WHERE lease_id = $1`,
        [r.leaseId],
      );
      expect(l.rows[0].source_pool).toBe('topup');
    });

    it('splits when monthly is insufficient but combined covers', async () => {
      await setBalance(1, 5, -25);
      const r = await grantLease(pool, {
        userId, organizationId: orgId, region: 'test', amountUsd: 3, ttlSeconds: 60,
      });
      expect(r.amountGranted).toBeCloseTo(3, 4);
      const b = await balances();
      expect(b.monthly).toBeCloseTo(0, 4);
      expect(b.topup).toBeCloseTo(3, 4); // 5 - 2
      const l = await pool.query(
        `SELECT source_pool, amount_usd, topup_amount_usd FROM credit_leases WHERE lease_id = $1`,
        [r.leaseId],
      );
      expect(l.rows[0].source_pool).toBe('split');
      expect(parseFloat(l.rows[0].amount_usd)).toBeCloseTo(3, 4);
      expect(parseFloat(l.rows[0].topup_amount_usd)).toBeCloseTo(2, 4);
    });
  });

  describe('settleLease — refund routing', () => {
    it('refunds a monthly-only lease back to monthly_allowance_usd', async () => {
      await setBalance(10, 0, -25);
      const grant = await grantLease(pool, {
        userId, organizationId: orgId, region: 'test', amountUsd: 4, ttlSeconds: 60,
      });
      if (!grant.leaseId) throw new Error('grant failed');
      const r = await settleLease(pool, { leaseId: grant.leaseId, actualUsd: 1 });
      expect(r.refundedUsd).toBeCloseTo(3, 4);
      const b = await balances();
      expect(b.monthly).toBeCloseTo(9, 4);
      expect(b.topup).toBeCloseTo(0, 4);
    });

    it('refunds a topup-only lease back to credits_usd', async () => {
      await setBalance(0, 10, -25);
      const grant = await grantLease(pool, {
        userId, organizationId: orgId, region: 'test', amountUsd: 4, ttlSeconds: 60,
      });
      if (!grant.leaseId) throw new Error('grant failed');
      const r = await settleLease(pool, { leaseId: grant.leaseId, actualUsd: 1 });
      expect(r.refundedUsd).toBeCloseTo(3, 4);
      const b = await balances();
      expect(b.monthly).toBeCloseTo(0, 4);
      expect(b.topup).toBeCloseTo(9, 4);
    });

    it('split-pool refund pro-rates back to both pools', async () => {
      // grant: monthly=1, topup=10, amount=3 -> monthlyDraw=1, topupDraw=2.
      // After grant: monthly=0, topup=8. settle actual=0.6 -> refund=2.4.
      // monthlyPortion=1, topupPortion=2 of granted=3.
      // monthlyRefund = 2.4 * 1 / 3 = 0.8; topupRefund = 2.4 - 0.8 = 1.6.
      await setBalance(1, 10, -25);
      const grant = await grantLease(pool, {
        userId, organizationId: orgId, region: 'test', amountUsd: 3, ttlSeconds: 60,
      });
      if (!grant.leaseId) throw new Error('grant failed');
      const r = await settleLease(pool, { leaseId: grant.leaseId, actualUsd: 0.6 });
      expect(r.refundedUsd).toBeCloseTo(2.4, 4);
      const b = await balances();
      expect(b.monthly).toBeCloseTo(0.8, 3);
      expect(b.topup).toBeCloseTo(9.6, 3); // 8 + 1.6
    });
  });

  describe('settleLease — signed delta', () => {
    it('charges MORE than reserved, taking the excess from credits_usd', async () => {
      await setBalance(0, 10, -25);
      const g = await grantLease(pool, {
        userId, organizationId: orgId, region: 'us-east-1',
        amountUsd: 0.0001, ttlSeconds: 60, allowFloor: true,
      });
      const res = await settleLease(pool, { leaseId: g.leaseId!, actualUsd: 0.110678 });
      expect(res.chargedUsd).toBeCloseTo(0.1107, 4);
      expect(res.additionalDebitUsd).toBeCloseTo(0.1106, 4);
      const b = await balances();
      // 10 − 0.0001 (reservation) − 0.1106 (true-up) = 9.8893
      expect(b.topup).toBeCloseTo(9.8893, 4);
    });

    it('refunds when actual is below the reservation', async () => {
      await setBalance(0, 10, -25);
      const g = await grantLease(pool, {
        userId, organizationId: orgId, region: 'us-east-1',
        amountUsd: 2, ttlSeconds: 60, allowFloor: true,
      });
      const res = await settleLease(pool, { leaseId: g.leaseId!, actualUsd: 0.5 });
      expect(res.refundedUsd).toBeCloseTo(1.5, 4);
      const b = await balances();
      expect(b.topup).toBeCloseTo(9.5, 4);
    });

    it('never drives monthly_allowance_usd negative on a true-up', async () => {
      await setBalance(0.05, 1, -25);
      const g = await grantLease(pool, {
        userId, organizationId: orgId, region: 'us-east-1',
        amountUsd: 0.0001, ttlSeconds: 60, allowFloor: true,
      });
      await settleLease(pool, { leaseId: g.leaseId!, actualUsd: 5 });
      const b = await balances();
      expect(b.monthly).toBeGreaterThanOrEqual(0);
      expect(b.topup).toBeLessThan(0);   // debt lands in credits_usd only
    });

    it('is idempotent once settled', async () => {
      await setBalance(0, 10, -25);
      const g = await grantLease(pool, {
        userId, organizationId: orgId, region: 'us-east-1',
        amountUsd: 0.0001, ttlSeconds: 60, allowFloor: true,
      });
      await settleLease(pool, { leaseId: g.leaseId!, actualUsd: 1 });
      const before = await balances();
      const second = await settleLease(pool, { leaseId: g.leaseId!, actualUsd: 1 });
      expect(second.chargedUsd).toBe(0);
      expect((await balances()).topup).toBeCloseTo(before.topup, 4);
    });

    // Regression for the live under-bill: an image whose rate cannot be resolved
    // estimated $0, was floored to MIN_LEASE_USD, and settle clamped the charge
    // to that — billing $0.0001 for real work.
    it('bills the true cost when the reservation was the MIN_LEASE_USD floor', async () => {
      await setBalance(0, 10, -25);
      const g = await grantLease(pool, {
        userId, organizationId: orgId, region: 'us-east-1',
        amountUsd: 0.0001, ttlSeconds: 60, allowFloor: true,
      });
      const res = await settleLease(pool, { leaseId: g.leaseId!, actualUsd: 0.04 });
      expect(res.chargedUsd).toBeCloseTo(0.04, 4);   // NOT 0.0001
      expect((await balances()).topup).toBeCloseTo(9.96, 4);
    });

    it('still charges a lease that was marked abandoned', async () => {
      await setBalance(0, 10, -25);
      const g = await grantLease(pool, {
        userId, organizationId: orgId, region: 'us-east-1',
        amountUsd: 0.0001, ttlSeconds: 60, allowFloor: true,
      });
      await pool.query(`UPDATE credit_leases SET status = 'abandoned' WHERE lease_id = $1`, [g.leaseId]);
      const res = await settleLease(pool, { leaseId: g.leaseId!, actualUsd: 0.75 });
      expect(res.chargedUsd).toBeCloseTo(0.75, 4);
      // 10 (topup) − 0.75 (total actual charge) = 9.25 exactly.
      expect((await balances()).topup).toBeCloseTo(9.25, 4);
    });
  });
});
