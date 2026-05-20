import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import {
  acquireForEstimatedCost, settleAfterCall, leaseTtlSeconds, InsufficientCreditsError,
} from './billing-gate.js';

const PLATFORM_URL = process.env.NEON_PLATFORM_PRIMARY_URL
  ?? 'postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control';
const RUN_DB_TESTS = process.env.RUN_DB_TESTS === '1';
const describeDb = RUN_DB_TESTS ? describe : describe.skip;

describeDb('billing-gate', () => {
  let pool: pg.Pool;
  let userId: string;

  beforeAll(() => { pool = new pg.Pool({ connectionString: PLATFORM_URL }); });
  afterAll(async () => { await pool.end(); });

  beforeEach(async () => {
    const u = await pool.query(
      `INSERT INTO platform_users (email, account_status, plan_id, credits_usd)
       VALUES ($1, 'active', 'free', 5.00) RETURNING id`,
      [`billing-gate-${Date.now()}-${Math.random()}@x.com`]
    );
    userId = u.rows[0].id;
  });

  it('acquires a lease equal to the estimate', async () => {
    const handle = await acquireForEstimatedCost(pool, userId, 'us-east-1', 1.0, 60);
    expect(handle.leaseId).toBeTruthy();
    expect(handle.amountGrantedUsd).toBeCloseTo(1.0, 4);
    const b = await pool.query(`SELECT credits_usd FROM platform_users WHERE id = $1`, [userId]);
    expect(parseFloat(b.rows[0].credits_usd)).toBeCloseTo(4.0, 4);
  });

  it('throws InsufficientCreditsError when balance is too low and refunds partial', async () => {
    await pool.query(`UPDATE platform_users SET credits_usd = 0.10 WHERE id = $1`, [userId]);
    await expect(
      acquireForEstimatedCost(pool, userId, 'us-east-1', 1.0, 60)
    ).rejects.toBeInstanceOf(InsufficientCreditsError);
    const b = await pool.query(`SELECT credits_usd FROM platform_users WHERE id = $1`, [userId]);
    expect(parseFloat(b.rows[0].credits_usd)).toBeCloseTo(0.10, 4);
  });

  it('settleAfterCall refunds the unspent portion', async () => {
    const handle = await acquireForEstimatedCost(pool, userId, 'us-east-1', 1.0, 60);
    const r = await settleAfterCall(pool, handle, 0.25);
    expect(r.refundedUsd).toBeCloseTo(0.75, 4);
    const b = await pool.query(`SELECT credits_usd FROM platform_users WHERE id = $1`, [userId]);
    expect(parseFloat(b.rows[0].credits_usd)).toBeCloseTo(4.75, 4); // 5 - 1 + 0.75
  });

  it('settleAfterCall is safe on a non-existent lease (returns refund=0)', async () => {
    const fake: any = { leaseId: '00000000-0000-0000-0000-000000000000', amountGrantedUsd: 1, expiresAt: new Date() };
    const r = await settleAfterCall(pool, fake, 1);
    expect(r.refundedUsd).toBe(0);
  });

  it('zero estimate is bumped to a tiny epsilon (0.0001) for accounting symmetry', async () => {
    const handle = await acquireForEstimatedCost(pool, userId, 'us-east-1', 0, 60);
    expect(handle.amountGrantedUsd).toBeCloseTo(0.0001, 6);
  });

  describe('leaseTtlSeconds', () => {
    it('clamps to [60, 600]', () => {
      expect(leaseTtlSeconds(0)).toBe(60);
      expect(leaseTtlSeconds(4096)).toBe(60 + Math.floor(4096 / 10));
      expect(leaseTtlSeconds(100000)).toBe(600);
    });
  });
});
