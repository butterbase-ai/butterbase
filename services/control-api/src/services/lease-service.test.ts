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
});
