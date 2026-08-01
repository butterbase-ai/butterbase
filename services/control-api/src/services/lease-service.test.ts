import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { grantLease, settleLease } from './lease-service.js';
import { config } from '../config.js';

const describeDb = process.env.RUN_DB_TESTS ? describe : describe.skip;
const __dirnameLease = path.dirname(fileURLToPath(import.meta.url));

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

  // Boundary: balance EXACTLY equal to the floor. The admission test is
  // `totalAvailable < floor`, so equality is ADMITTED. This is deliberate:
  // the floor is the last usable point, not a line you must stay above.
  // Rejecting at equality would buy nothing — a balance one hundredth of a
  // cent above the floor admits the same job with the same overshoot — while
  // making `credit_floor_usd = 0` silently mean "needs a strictly positive
  // balance". Overshoot is bounded at one job either way, and every
  // subsequent call is refused because the balance is then below the floor.
  it('admits a request when the balance is EXACTLY at the floor', async () => {
    await setBalance(0, -25, -25);
    const res = await grantLease(pool, {
      userId, organizationId: orgId, region: 'us-east-1',
      amountUsd: 0.0001, ttlSeconds: 60, allowFloor: true,
    });
    expect(res.leaseId).not.toBeNull();
    expect(res.balanceUsd).toBeCloseTo(-25, 4);
    expect(res.floorUsd).toBeCloseTo(-25, 4);
    // The grant pushes the balance below the floor...
    expect((await balances()).topup).toBeCloseTo(-25.0001, 4);
    // ...so the very next request is refused. One job of overshoot, no more.
    const next = await grantLease(pool, {
      userId, organizationId: orgId, region: 'us-east-1',
      amountUsd: 0.0001, ttlSeconds: 60, allowFloor: true,
    });
    expect(next.leaseId).toBeNull();
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

  // Every test in this block exercises reserve-small settle semantics, so it
  // passes allowOverdraft explicitly. Flag-off (legacy) settle is covered in
  // the 'settleLease — legacy clamping (allowOverdraft off)' block below.
  describe('settleLease — signed delta', () => {
    it('charges MORE than reserved, taking the excess from credits_usd', async () => {
      await setBalance(0, 10, -25);
      const g = await grantLease(pool, {
        userId, organizationId: orgId, region: 'us-east-1',
        amountUsd: 0.0001, ttlSeconds: 60, allowFloor: true,
      });
      const res = await settleLease(pool, { leaseId: g.leaseId!, actualUsd: 0.110678, allowOverdraft: true });
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
      const res = await settleLease(pool, { leaseId: g.leaseId!, actualUsd: 0.5, allowOverdraft: true });
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
      await settleLease(pool, { leaseId: g.leaseId!, actualUsd: 5, allowOverdraft: true });
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
      await settleLease(pool, { leaseId: g.leaseId!, actualUsd: 1, allowOverdraft: true });
      const before = await balances();
      const second = await settleLease(pool, { leaseId: g.leaseId!, actualUsd: 1, allowOverdraft: true });
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
      const res = await settleLease(pool, { leaseId: g.leaseId!, actualUsd: 0.04, allowOverdraft: true });
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
      const res = await settleLease(pool, { leaseId: g.leaseId!, actualUsd: 0.75, allowOverdraft: true });
      expect(res.chargedUsd).toBeCloseTo(0.75, 4);
      // 10 (topup) − 0.75 (total actual charge) = 9.25 exactly.
      expect((await balances()).topup).toBeCloseTo(9.25, 4);
    });
  });

  // ---------------------------------------------------------------------
  // Flag-OFF settle path. This is what production runs with
  // AI_RESERVE_SMALL_ENABLED unset, and it must stay byte-identical to the
  // pre-reserve-small behaviour: the charge is clamped to [0, granted],
  // nothing can debit beyond the reservation, and only 'active' settles.
  // ---------------------------------------------------------------------
  describe('settleLease — legacy clamping (allowOverdraft off)', () => {
    it('clamps an actual ABOVE the reservation down to the granted amount', async () => {
      await setBalance(0, 10, 0);
      const g = await grantLease(pool, {
        userId, organizationId: orgId, region: 'us-east-1',
        amountUsd: 2, ttlSeconds: 60,
      });
      // Upstream reports $7.50 but only $2 was reserved: legacy bills $2.
      const res = await settleLease(pool, { leaseId: g.leaseId!, actualUsd: 7.5 });
      expect(res.chargedUsd).toBeCloseTo(2, 4);
      expect(res.additionalDebitUsd).toBe(0);
      expect(res.refundedUsd).toBe(0);
      // 10 − 2 (reservation) and no true-up: the customer is not overdrafted.
      expect((await balances()).topup).toBeCloseTo(8, 4);
    });

    // Money guard: Math.max(0, actualUsd). A negative actual would otherwise
    // become a credit — an upstream reporting a negative cost must never pay
    // the customer.
    it('clamps a NEGATIVE actual to zero and refunds the whole reservation', async () => {
      await setBalance(0, 10, 0);
      const g = await grantLease(pool, {
        userId, organizationId: orgId, region: 'us-east-1',
        amountUsd: 2, ttlSeconds: 60,
      });
      const res = await settleLease(pool, { leaseId: g.leaseId!, actualUsd: -5 });
      expect(res.chargedUsd).toBe(0);
      expect(res.refundedUsd).toBeCloseTo(2, 4);   // exactly the reservation, no more
      expect(res.additionalDebitUsd).toBe(0);
      expect((await balances()).topup).toBeCloseTo(10, 4); // whole, not 15
    });

    it('clamps a NEGATIVE actual to zero on the reserve-small path too', async () => {
      await setBalance(0, 10, -25);
      const g = await grantLease(pool, {
        userId, organizationId: orgId, region: 'us-east-1',
        amountUsd: 2, ttlSeconds: 60, allowFloor: true,
      });
      const res = await settleLease(pool, { leaseId: g.leaseId!, actualUsd: -5, allowOverdraft: true });
      expect(res.chargedUsd).toBe(0);
      expect(res.refundedUsd).toBeCloseTo(2, 4);
      expect((await balances()).topup).toBeCloseTo(10, 4);
    });

    it('treats an abandoned lease as terminal (no charge) when allowOverdraft is off', async () => {
      await setBalance(0, 10, 0);
      const g = await grantLease(pool, {
        userId, organizationId: orgId, region: 'us-east-1',
        amountUsd: 2, ttlSeconds: 60,
      });
      await pool.query(`UPDATE credit_leases SET status = 'abandoned' WHERE lease_id = $1`, [g.leaseId]);
      const res = await settleLease(pool, { leaseId: g.leaseId!, actualUsd: 1.5 });
      expect(res.chargedUsd).toBe(0);
      expect(res.refundedUsd).toBe(0);
      expect((await balances()).topup).toBeCloseTo(8, 4); // untouched by the settle
    });
  });
});

// ---------------------------------------------------------------------
// Plan-floor inheritance (Task 13). organizations.credit_floor_usd is
// nullable: NULL means "inherit plans.credit_floor_usd", a non-NULL value is
// a per-org override. Resolution is
//   COALESCE(organizations.credit_floor_usd, plans.credit_floor_usd, 0).
//
// These tests create their own orgs (varying plan_id and the floor override)
// rather than reusing the fixture above, which is pinned to plan_id
// 'playground'. Each follows the same owner_id / personal_organization_id
// circular-FK pattern as the outer beforeAll: pre-generate a UUID and insert
// both rows inside one BEGIN/COMMIT.
// ---------------------------------------------------------------------
describeDb('grantLease — plan floor inheritance', () => {
  let pool2: pg.Pool;

  beforeAll(async () => {
    pool2 = new pg.Pool({ connectionString: config.controlDb.url });
  });

  afterAll(async () => {
    await pool2.end();
  });

  async function createOrg(planId: string | null): Promise<{ orgId: string; userId: string }> {
    const suffix = crypto.randomUUID();
    const client = await pool2.connect();
    try {
      await client.query('BEGIN');
      const tmpId = crypto.randomUUID();
      const orgResult = await client.query<{ id: string }>(
        `INSERT INTO organizations (owner_id, name, personal, plan_id, credits_usd, monthly_allowance_usd, auto_refill_enabled, account_status)
         VALUES ($1, 'plan-floor-test-org', true, $2, 0, 0, false, 'active')
         RETURNING id`,
        [tmpId, planId],
      );
      const orgId = orgResult.rows[0].id;
      const userResult = await client.query<{ id: string }>(
        `INSERT INTO platform_users (id, email, personal_organization_id)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [tmpId, `plan-floor-test-${suffix}@example.com`, orgId],
      );
      const userId = userResult.rows[0].id;
      await client.query('COMMIT');
      return { orgId, userId };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async function cleanupOrg(orgId: string, userId: string) {
    await pool2.query(`DELETE FROM credit_leases WHERE organization_id = $1`, [orgId]);
    await pool2.query(`DELETE FROM platform_users WHERE id = $1`, [userId]);
    await pool2.query(`DELETE FROM organizations WHERE id = $1`, [orgId]);
  }

  it('inherits the plan floor when the org override is NULL: admits above it, refuses below it', async () => {
    // 'launch' plan is seeded to credit_floor_usd = -10.
    const { orgId: launchOrgId, userId: launchUserId } = await createOrg('launch');
    try {
      await pool2.query(
        `UPDATE organizations SET credits_usd = -5, monthly_allowance_usd = 0, credit_floor_usd = NULL WHERE id = $1`,
        [launchOrgId],
      );
      const admitted = await grantLease(pool2, {
        userId: launchUserId, organizationId: launchOrgId, region: 'us-east-1',
        amountUsd: 0.0001, ttlSeconds: 60, allowFloor: true,
      });
      expect(admitted.leaseId).not.toBeNull();
      expect(admitted.floorUsd).toBeCloseTo(-10, 4);

      await pool2.query(
        `UPDATE organizations SET credits_usd = -15, monthly_allowance_usd = 0, credit_floor_usd = NULL WHERE id = $1`,
        [launchOrgId],
      );
      const refused = await grantLease(pool2, {
        userId: launchUserId, organizationId: launchOrgId, region: 'us-east-1',
        amountUsd: 0.0001, ttlSeconds: 60, allowFloor: true,
      });
      expect(refused.leaseId).toBeNull();
      expect(refused.floorUsd).toBeCloseTo(-10, 4);
    } finally {
      await cleanupOrg(launchOrgId, launchUserId);
    }
  });

  it('a per-org override beats the plan default', async () => {
    // Same 'launch' plan (floor -10), but this org overrides to -50.
    const { orgId, userId } = await createOrg('launch');
    try {
      await pool2.query(
        `UPDATE organizations SET credits_usd = -30, monthly_allowance_usd = 0, credit_floor_usd = -50 WHERE id = $1`,
        [orgId],
      );
      const res = await grantLease(pool2, {
        userId, organizationId: orgId, region: 'us-east-1',
        amountUsd: 0.0001, ttlSeconds: 60, allowFloor: true,
      });
      expect(res.leaseId).not.toBeNull();
      expect(res.floorUsd).toBeCloseTo(-50, 4);
    } finally {
      await cleanupOrg(orgId, userId);
    }
  });

  it('the playground plan floor (0) extends no credit: refused at any negative balance', async () => {
    const { orgId, userId } = await createOrg('playground');
    try {
      await pool2.query(
        `UPDATE organizations SET credits_usd = -0.01, monthly_allowance_usd = 0, credit_floor_usd = NULL WHERE id = $1`,
        [orgId],
      );
      const res = await grantLease(pool2, {
        userId, organizationId: orgId, region: 'us-east-1',
        amountUsd: 0.0001, ttlSeconds: 60, allowFloor: true,
      });
      expect(res.leaseId).toBeNull();
      expect(res.floorUsd).toBeCloseTo(0, 4);
    } finally {
      await cleanupOrg(orgId, userId);
    }
  });

  it('a NULL or dangling plan_id resolves the floor to 0, not NULL, and does not crash', async () => {
    const { orgId, userId } = await createOrg(null);
    try {
      await pool2.query(
        `UPDATE organizations SET credits_usd = 5, monthly_allowance_usd = 0, credit_floor_usd = NULL WHERE id = $1`,
        [orgId],
      );
      const res = await grantLease(pool2, {
        userId, organizationId: orgId, region: 'us-east-1',
        amountUsd: 1, ttlSeconds: 60, allowFloor: true,
      });
      expect(res.leaseId).not.toBeNull();
      expect(res.floorUsd).toBeCloseTo(0, 4);
    } finally {
      await cleanupOrg(orgId, userId);
    }
  });
});

// ---------------------------------------------------------------------
// Migration-phasing regression guard.
//
// The original 098 dropped organizations.credit_floor_usd's DEFAULT and
// nulled out every row in the same migration that the deploy-order rule
// requires to run BEFORE the code deploy. The old build reads that column as
// `parseFloat(row.credit_floor_usd)`, not through COALESCE — NULL becomes
// NaN, `balance < NaN` is always false, and every AI request is admitted
// regardless of balance. So the destructive half was moved into post-deploy
// migrations (103 DROP DEFAULT, 104 null-out), and 102 repairs environments
// that already ran the unsplit 098.
//
// The tests below assert the PHASING, not COALESCE semantics (covered above).
// Earlier attempts asserted new-code behaviour against hand-UPDATEd rows;
// those passed even with the phasing fully reverted, because the code under
// test never reads the migration files or the column's default. These read
// the migration text and the live schema instead, so reverting the split —
// putting a null-out or a DROP DEFAULT back into a pre-deploy file — fails
// them.
// ---------------------------------------------------------------------

const MIGRATIONS_DIR = path.resolve(__dirnameLease, '../../../../db/control-plane');
const PRE_DEPLOY_MIGRATIONS = [
  '098_credit_floor_and_abandoned_leases.sql',
  '099_validate_credit_leases_status_check.sql',
  '100_seed_plan_credit_floors.sql',
  '101_null_out_org_credit_floor_default.sql',
  '102_repair_org_credit_floor_default.sql',
];
const POST_DEPLOY_MIGRATIONS = [
  '103_drop_org_credit_floor_default.sql',
  '104_null_out_org_credit_floor.sql',
];

/** Migration text with comment lines stripped, so prose can mention what the SQL must not do. */
function migrationStatements(file: string): string {
  return fs
    .readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8')
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');
}

describe('credit_floor_usd migration phasing — migration text', () => {
  it('no pre-deploy migration nulls out organizations.credit_floor_usd or drops its DEFAULT', () => {
    for (const file of PRE_DEPLOY_MIGRATIONS) {
      const sql = migrationStatements(file);
      // A NULL in this column is what the old code turns into NaN. Neither
      // route to one — UPDATE ... = NULL, or DROP DEFAULT letting an INSERT
      // produce one — may appear before the code deploy.
      expect(sql, `${file} must not null out credit_floor_usd`).not.toMatch(
        /credit_floor_usd\s*=\s*NULL/i,
      );
      expect(sql, `${file} must not drop the credit_floor_usd DEFAULT`).not.toMatch(
        /credit_floor_usd\s+DROP\s+DEFAULT/i,
      );
    }
  });

  it('the pre-deploy set leaves the column with DEFAULT 0', () => {
    const combined = PRE_DEPLOY_MIGRATIONS.map(migrationStatements).join('\n');
    expect(combined).toMatch(/credit_floor_usd\s+SET\s+DEFAULT\s+0/i);
    expect(combined).toMatch(/credit_floor_usd\s+IS\s+NULL/i);
  });

  it('the post-deploy work is split across two files, one lock-heavy statement each', () => {
    const dropDefault = migrationStatements(POST_DEPLOY_MIGRATIONS[0]);
    const nullOut = migrationStatements(POST_DEPLOY_MIGRATIONS[1]);
    expect(dropDefault).toMatch(/credit_floor_usd\s+DROP\s+DEFAULT/i);
    expect(dropDefault).not.toMatch(/credit_floor_usd\s*=\s*NULL/i);
    expect(nullOut).toMatch(/credit_floor_usd\s*=\s*NULL/i);
    // ACCESS EXCLUSIVE (blocks reads) must not be held across the whole-table
    // scan: the runner wraps each FILE in one transaction.
    expect(nullOut).not.toMatch(/DROP\s+DEFAULT/i);
  });
});

describeDb('credit_floor_usd migration phasing — live schema', () => {
  let poolSchema: pg.Pool;

  beforeAll(async () => {
    poolSchema = new pg.Pool({ connectionString: config.controlDb.url });
  });

  afterAll(async () => {
    await poolSchema.end();
  });

  it('the column shape matches the migration phase this DB is actually in', async () => {
    const applied = await poolSchema.query<{ filename: string }>(
      `SELECT filename FROM _migrations WHERE filename = ANY($1)`,
      [POST_DEPLOY_MIGRATIONS],
    );
    const postDeployApplied = applied.rows.length > 0;

    const col = await poolSchema.query<{ column_default: string | null; is_nullable: string }>(
      `SELECT column_default, is_nullable
         FROM information_schema.columns
        WHERE table_name = 'organizations' AND column_name = 'credit_floor_usd'`,
    );
    expect(col.rows).toHaveLength(1);
    // Nullable in every phase — 098 makes it so, and the new code's COALESCE
    // depends on it. A NOT NULL here means 098 was reverted.
    expect(col.rows[0].is_nullable).toEqual('YES');

    const nulls = await poolSchema.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM organizations WHERE credit_floor_usd IS NULL`,
    );

    if (!postDeployApplied) {
      // Pre-deploy phase: old code may still be live, so it must never be able
      // to observe a NULL — neither on an existing row nor on a fresh INSERT.
      expect(col.rows[0].column_default, 'pre-deploy: DEFAULT 0 must still be attached').toEqual(
        '0',
      );
      expect(nulls.rows[0].n, 'pre-deploy: no org may have a NULL credit_floor_usd').toEqual('0');
    } else {
      // Post-deploy phase: the default is gone and NULL means "inherit plan".
      expect(col.rows[0].column_default).toBeNull();
    }
  });
});
