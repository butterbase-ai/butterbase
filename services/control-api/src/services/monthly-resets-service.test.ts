import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { resetMonthlyAllowance } from './monthly-resets-service.js';

const PLATFORM_URL = process.env.NEON_PLATFORM_PRIMARY_URL
  ?? 'postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control';
const RUN_DB_TESTS = process.env.RUN_DB_TESTS === '1';
const describeDb = RUN_DB_TESTS ? describe : describe.skip;

describeDb('resetMonthlyAllowance', () => {
  let pool: pg.Pool;
  let userId: string;
  const planId = 'starter';

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: PLATFORM_URL });
    await pool.query(`UPDATE plans SET monthly_credit_grant_usd = 10 WHERE id = $1`, [planId]);
  });
  afterAll(async () => {
    await pool.query(`UPDATE plans SET monthly_credit_grant_usd = 0 WHERE id = $1`, [planId]);
    await pool.end();
  });

  beforeEach(async () => {
    // Fixture: insert a user + personal org, seed the org with $3.50 allowance
    // (migration 093 moved the monthly pool from platform_users to organizations).
    const orgResult = await pool.query(
      `INSERT INTO organizations (name, personal, plan_id, credits_usd, monthly_allowance_usd, stripe_customer_id)
       VALUES ($1, true, $2, 0, 3.50, $3) RETURNING id`,
      [`reset-org-${Date.now()}-${Math.random()}`, planId, `cus_reset_${Date.now()}_${Math.random()}`]
    );
    const orgId = orgResult.rows[0].id;
    const u = await pool.query(
      `INSERT INTO platform_users (email, account_status, plan_id, personal_organization_id)
       VALUES ($1, 'active', $2, $3) RETURNING id`,
      [`monthly-reset-${Date.now()}-${Math.random()}@x.com`, planId, orgId]
    );
    userId = u.rows[0].id;
  });

  it('SETs monthly_allowance to the plan grant and records previous_unspent', async () => {
    const r = await resetMonthlyAllowance(pool, { userId, planId, stripeEventId: `evt_${Date.now()}_a` });
    expect(r.newAmount).toBeCloseTo(10, 2);
    expect(r.previousUnspent).toBeCloseTo(3.50, 2);
    const u = await pool.query(
      `SELECT o.monthly_allowance_usd FROM organizations o
       JOIN platform_users pu ON pu.personal_organization_id = o.id
       WHERE pu.id = $1`,
      [userId]
    );
    expect(parseFloat(u.rows[0].monthly_allowance_usd)).toBeCloseTo(10, 2);

    const audit = await pool.query(
      `SELECT amount_usd, previous_unspent_usd FROM monthly_credit_resets WHERE user_id = $1`,
      [userId]
    );
    expect(audit.rows).toHaveLength(1);
    expect(parseFloat(audit.rows[0].amount_usd)).toBeCloseTo(10, 2);
    expect(parseFloat(audit.rows[0].previous_unspent_usd)).toBeCloseTo(3.50, 2);
  });

  it('is idempotent on duplicate stripe_event_id', async () => {
    const eventId = `evt_dup_${Date.now()}_${Math.random()}`;
    const r1 = await resetMonthlyAllowance(pool, { userId, planId, stripeEventId: eventId });
    expect(r1.newAmount).toBeCloseTo(10, 2);

    // simulate spending after the reset
    await pool.query(
      `UPDATE organizations SET monthly_allowance_usd = 4
       WHERE id = (SELECT personal_organization_id FROM platform_users WHERE id = $1)`,
      [userId]
    );

    const r2 = await resetMonthlyAllowance(pool, { userId, planId, stripeEventId: eventId });
    expect(r2.skippedDuplicate).toBe(true);
    expect(r2.newAmount).toBeCloseTo(4, 2); // unchanged
    const u = await pool.query(
      `SELECT o.monthly_allowance_usd FROM organizations o
       JOIN platform_users pu ON pu.personal_organization_id = o.id
       WHERE pu.id = $1`,
      [userId]
    );
    expect(parseFloat(u.rows[0].monthly_allowance_usd)).toBeCloseTo(4, 2);
  });

  it('no-op (newAmount=0) when plan monthly grant is 0 but still SETs (overwrites) for use-it-or-lose-it', async () => {
    await pool.query(`UPDATE plans SET monthly_credit_grant_usd = 0 WHERE id = $1`, [planId]);
    const r = await resetMonthlyAllowance(pool, { userId, planId, stripeEventId: `evt_zero_${Date.now()}_${Math.random()}` });
    expect(r.newAmount).toBe(0);
    expect(r.previousUnspent).toBeCloseTo(3.50, 2);
    // The SET still applied: monthly_allowance is now 0 (3.50 was lost — use-it-or-lose-it)
    const u = await pool.query(
      `SELECT o.monthly_allowance_usd FROM organizations o
       JOIN platform_users pu ON pu.personal_organization_id = o.id
       WHERE pu.id = $1`,
      [userId]
    );
    expect(parseFloat(u.rows[0].monthly_allowance_usd)).toBeCloseTo(0, 2);
    // restore
    await pool.query(`UPDATE plans SET monthly_credit_grant_usd = 10 WHERE id = $1`, [planId]);
  });

  it('throws when plan not found', async () => {
    await expect(
      resetMonthlyAllowance(pool, { userId, planId: 'no-such-plan', stripeEventId: `evt_${Date.now()}` })
    ).rejects.toThrow(/plan no-such-plan not found/);
  });

  it('throws when user not found', async () => {
    await expect(
      resetMonthlyAllowance(pool, {
        userId: '00000000-0000-0000-0000-000000000000',
        planId,
        stripeEventId: `evt_${Date.now()}`,
      })
    ).rejects.toThrow(/user .* not found/);
  });
});
