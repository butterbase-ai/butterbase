import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { grantSignupCredits } from '../services/credit-grants-service.js';

const PLATFORM_URL = process.env.NEON_PLATFORM_PRIMARY_URL
  ?? 'postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control';

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === '1';
const describeDb = RUN_DB_TESTS ? describe : describe.skip;

describeDb('signup grant integration', () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: PLATFORM_URL });
    await pool.query(`UPDATE plans SET signup_credit_grant_usd = 2.00 WHERE id = 'free'`);
  });
  afterAll(async () => { await pool.end(); });

  it('first call grants signup credits exactly once', async () => {
    const ins = await pool.query(
      `INSERT INTO platform_users (id, email, account_status, plan_id, credits_usd)
       VALUES (gen_random_uuid(), $1, 'active', 'free', 0)
       RETURNING id`,
      [`signup-grant-test-${Date.now()}-${Math.random()}@x.com`]
    );
    const userId = ins.rows[0].id;

    const r1 = await grantSignupCredits(pool, { userId, planId: 'free' });
    expect(r1.granted).toBeCloseTo(2, 2);

    // Second call (simulating a returning user re-authenticating)
    const r2 = await grantSignupCredits(pool, { userId, planId: 'free' });
    expect(r2.granted).toBe(0);

    const balance = await pool.query(`SELECT credits_usd FROM platform_users WHERE id = $1`, [userId]);
    expect(parseFloat(balance.rows[0].credits_usd)).toBeCloseTo(2, 2);
  });
});
