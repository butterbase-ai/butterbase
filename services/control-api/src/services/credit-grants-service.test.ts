import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { grantSignupCredits, getCreditGrants } from './credit-grants-service.js';

const PLATFORM_URL = process.env.NEON_PLATFORM_PRIMARY_URL
  ?? 'postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control';

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === '1';
const describeDb = RUN_DB_TESTS ? describe : describe.skip;

describeDb('credit-grants-service', () => {
  let pool: pg.Pool;
  let userId: string;
  const planId = 'playground';

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: PLATFORM_URL });
    // Ensure the 'free' plan has known grant values for these tests.
    await pool.query(
      `UPDATE plans SET signup_credit_grant_usd = 2.00, monthly_credit_grant_usd = 0
       WHERE id = $1`,
      [planId]
    );
  });

  afterAll(async () => { await pool.end(); });

  beforeEach(async () => {
    const u = await pool.query(
      `INSERT INTO platform_users (id, email, account_status, plan_id, credits_usd)
       VALUES (gen_random_uuid(), $1, 'active', $2, 0) RETURNING id`,
      [`credit-grants-test-${Date.now()}-${Math.random()}@x.com`, planId]
    );
    userId = u.rows[0].id;
  });

  describe('grantSignupCredits', () => {
    it('SETs monthly_allowance_usd to the plan signup amount', async () => {
      const r = await grantSignupCredits(pool, { userId, planId });
      expect(r.granted).toBeCloseTo(2.00, 2);

      const u = await pool.query(`SELECT monthly_allowance_usd, credits_usd FROM platform_users WHERE id = $1`, [userId]);
      expect(parseFloat(u.rows[0].monthly_allowance_usd)).toBeCloseTo(2.00, 2);
      expect(parseFloat(u.rows[0].credits_usd)).toBeCloseTo(0, 2); // topup pool untouched

      const g = await pool.query(`SELECT amount_usd, reason FROM credit_grants WHERE user_id = $1`, [userId]);
      expect(g.rows).toHaveLength(1);
      expect(g.rows[0].reason).toBe('signup');
      expect(parseFloat(g.rows[0].amount_usd)).toBeCloseTo(2.00, 2);
    });

    it('is idempotent: second call returns granted=0 and does not double-credit', async () => {
      await grantSignupCredits(pool, { userId, planId });
      const second = await grantSignupCredits(pool, { userId, planId });

      expect(second.granted).toBe(0);
      const u = await pool.query(`SELECT monthly_allowance_usd FROM platform_users WHERE id = $1`, [userId]);
      expect(parseFloat(u.rows[0].monthly_allowance_usd)).toBeCloseTo(2.00, 2);
      const g = await pool.query(
        `SELECT count(*)::int AS c FROM credit_grants WHERE user_id = $1 AND reason = 'signup'`,
        [userId]
      );
      expect(g.rows[0].c).toBe(1);
    });

    it('returns granted=0 when plan signup grant is 0', async () => {
      await pool.query(`UPDATE plans SET signup_credit_grant_usd = 0 WHERE id = $1`, [planId]);
      const res = await grantSignupCredits(pool, { userId, planId });
      expect(res.granted).toBe(0);
      // restore for subsequent tests
      await pool.query(`UPDATE plans SET signup_credit_grant_usd = 2.00 WHERE id = $1`, [planId]);
    });
  });

  describe('getCreditGrants', () => {
    it('returns grants for a user newest first', async () => {
      // Insert two grants manually with different reasons so we can assert ordering.
      await pool.query(
        `INSERT INTO credit_grants (user_id, plan_id, amount_usd, reason) VALUES ($1, $2, 1.00, 'signup')`,
        [userId, planId]
      );
      // Small delay so created_at differs reliably.
      await new Promise(r => setTimeout(r, 5));
      await pool.query(
        `INSERT INTO credit_grants (user_id, plan_id, amount_usd, reason) VALUES ($1, $2, 2.00, 'manual')`,
        [userId, planId]
      );

      const list = await getCreditGrants(pool, userId, 10);
      expect(list).toHaveLength(2);
      expect(list[0].reason).toBe('manual');
      expect(list[1].reason).toBe('signup');
    });
  });
});
