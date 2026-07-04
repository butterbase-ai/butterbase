import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { readOrgBillingState, applyLease, burnLease } from './org-billing-state.js';

const RUNTIME_URL = process.env.NEON_RUNTIME_PROJECT_ID_US_EAST_1
  ?? 'postgresql://butterbase:butterbase_dev@localhost:5437/butterbase_runtime_us';

let pool: pg.Pool;
const testUserId = '00000000-0000-0000-0000-00000000abcd';

beforeAll(async () => { pool = new pg.Pool({ connectionString: RUNTIME_URL }); });
afterAll(async () => { await pool.end(); });
beforeEach(async () => { await pool.query(`DELETE FROM user_billing_state WHERE user_id = $1`, [testUserId]); });

describe('readOrgBillingState', () => {
  it('returns null for unknown user', async () => {
    const r = await readOrgBillingState(pool, testUserId);
    expect(r).toBeNull();
  });

  it('returns the row for known user', async () => {
    await pool.query(`INSERT INTO user_billing_state (user_id, plan_id, account_status) VALUES ($1, 'pro', 'active')`, [testUserId]);
    const r = await readOrgBillingState(pool, testUserId);
    expect(r).toMatchObject({ plan_id: 'pro', account_status: 'active' });
  });
});

describe('applyLease', () => {
  it('inserts row with lease values when missing', async () => {
    const expires = new Date(Date.now() + 300_000);
    await applyLease(pool, testUserId, 1, expires);
    const r = await readOrgBillingState(pool, testUserId);
    expect(parseFloat(r!.topup_lease_remaining_usd as any)).toBe(1);
    expect(new Date(r!.lease_expires_at!).getTime()).toBe(expires.getTime());
  });

  it('replaces existing lease (does not accumulate)', async () => {
    await pool.query(`INSERT INTO user_billing_state (user_id, topup_lease_remaining_usd, lease_expires_at) VALUES ($1, 0.50, now())`, [testUserId]);
    const expires = new Date(Date.now() + 300_000);
    await applyLease(pool, testUserId, 1, expires);
    const r = await readOrgBillingState(pool, testUserId);
    expect(parseFloat(r!.topup_lease_remaining_usd as any)).toBe(1);
  });
});

describe('burnLease', () => {
  it('decrements atomically and returns new remaining', async () => {
    await applyLease(pool, testUserId, 1, new Date(Date.now() + 300_000));
    const r = await burnLease(pool, testUserId, 0.30);
    expect(r.remaining).toBeCloseTo(0.70, 2);
    expect(r.allowed).toBe(true);
  });

  it('refuses to go negative; returns allowed=false', async () => {
    await applyLease(pool, testUserId, 0.10, new Date(Date.now() + 300_000));
    const r = await burnLease(pool, testUserId, 1);
    expect(r.allowed).toBe(false);
    const after = await readOrgBillingState(pool, testUserId);
    expect(parseFloat(after!.topup_lease_remaining_usd as any)).toBe(0.10);
  });

  it('refuses if lease expired', async () => {
    await applyLease(pool, testUserId, 1, new Date(Date.now() - 1000));
    const r = await burnLease(pool, testUserId, 0.10);
    expect(r.allowed).toBe(false);
  });
});
