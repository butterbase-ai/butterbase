import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { grantLease, settleLease } from './lease-service.js';
import { reclaimExpiredLeases } from './lease-reclaim.js';
import { acquireForEstimatedCost } from './ai-router/billing-gate.js';
import { reserveActorCredits } from './actor-providers/billing.js';

// Explicit opt-in: these tests never use application/production DB credentials.
const databaseUrl = process.env.LEASE_PRECISION_TEST_DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

describeDb('credit settlement preserves small charges', () => {
  const schema = `lease_precision_${randomUUID().replaceAll('-', '')}`;
  const organizationId = randomUUID();
  const legacyOrganizationId = randomUUID();
  const userId = randomUUID();
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    // Start at the deployed precision. Omitting either migration must make
    // the stored-value regressions fail, even if the application math is fixed.
    await pool.query(`
      CREATE TABLE plans (id text PRIMARY KEY, credit_floor_usd numeric(12,4));
      CREATE TABLE organizations (
        id uuid PRIMARY KEY, plan_id text, credit_floor_usd numeric(12,4),
        monthly_allowance_usd numeric(12,4) NOT NULL DEFAULT 0,
        credits_usd numeric(12,4) NOT NULL DEFAULT 0
      );
      CREATE TABLE credit_leases (
        lease_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL,
        organization_id uuid NOT NULL, region text NOT NULL,
        amount_usd numeric(12,4) NOT NULL CHECK (amount_usd > 0),
        settled_amount_usd numeric(10,4), topup_amount_usd numeric(10,4),
        status text NOT NULL, source_pool text NOT NULL,
        expires_at timestamptz NOT NULL, granted_at timestamptz NOT NULL DEFAULT now(),
        settled_at timestamptz, reclaimed_at timestamptz
      );
      CREATE TABLE credit_reservation_closures (
        reservation_id uuid PRIMARY KEY, organization_id uuid NOT NULL,
        had_lease boolean NOT NULL, closed_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE monthly_credit_resets (previous_unspent_usd numeric(10,4));
      CREATE TABLE ai_usage_logs (
        provider_cost_usd numeric(12,6), charged_credits_usd numeric(12,6), cost_usd numeric(10,6)
      );
    `);
    await pool.query('INSERT INTO organizations (id, credits_usd) VALUES ($1, 10.1234), ($2, 1)', [legacyOrganizationId, organizationId]);
    const migrations = [
      '../../../../db/control-plane/129_credit_settlement_precision.sql',
      '../../../../db/runtime-plane/062_ai_usage_cost_precision.sql',
    ];
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const relative of migrations) {
        const file = fileURLToPath(new URL(relative, import.meta.url));
        if (fs.existsSync(file)) await client.query(fs.readFileSync(file, 'utf8'));
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    }
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM credit_leases');
    await pool.query('UPDATE organizations SET monthly_allowance_usd=0, credits_usd=10 WHERE id=$1', [organizationId]);
  });

  async function grant(amountUsd = 0.0001, reservationId?: string) {
    return grantLease(pool, { userId, organizationId, region: 'test', amountUsd,
      ttlSeconds: 60, allowFloor: true, reservationId });
  }

  async function balances() {
    const result = await pool.query('SELECT monthly_allowance_usd, credits_usd FROM organizations WHERE id=$1', [organizationId]);
    return { monthly: Number(result.rows[0].monthly_allowance_usd), topup: Number(result.rows[0].credits_usd) };
  }

  it.each([
    { name: 'monthly', monthly: 10, topup: 0, wantMonthly: 9.999952, wantTopup: 0 },
    { name: 'topup', monthly: 0, topup: 10, wantMonthly: 0, wantTopup: 9.999952 },
    { name: 'split', monthly: 0.00004, topup: 10, wantMonthly: 0.0000208, wantTopup: 9.9999712 },
  ])('deducts 0.000048 USD from $name balances and records the same charge', async (test) => {
    await pool.query('UPDATE organizations SET monthly_allowance_usd=$1, credits_usd=$2 WHERE id=$3', [test.monthly, test.topup, organizationId]);
    const lease = await grant();
    const settled = await settleLease(pool, { leaseId: lease.leaseId!, actualUsd: 0.000048, allowOverdraft: true });
    expect(settled.chargedUsd).toBe(0.000048);
    expect(settled.refundedUsd).toBe(0.000052);
    expect(await balances()).toEqual({ monthly: test.wantMonthly, topup: test.wantTopup });
    const stored = await pool.query('SELECT settled_amount_usd FROM credit_leases WHERE lease_id=$1', [lease.leaseId]);
    expect(Number(stored.rows[0].settled_amount_usd)).toBe(0.000048);
    // A replay must neither debit nor refund the micro-charge a second time.
    expect((await settleLease(pool, { leaseId: lease.leaseId!, actualUsd: 0.000048, allowOverdraft: true })).chargedUsd).toBe(0);
    expect(await balances()).toEqual({ monthly: test.wantMonthly, topup: test.wantTopup });
  });

  it('collects all six cached requests instead of refunding every reservation', async () => {
    for (let i = 0; i < 6; i++) {
      const lease = await grant();
      await settleLease(pool, { leaseId: lease.leaseId!, actualUsd: 0.000048, allowOverdraft: true });
    }
    expect((await balances()).topup).toBe(9.999712);
    const stored = await pool.query('SELECT SUM(settled_amount_usd) AS total FROM credit_leases');
    expect(Number(stored.rows[0].total)).toBe(0.000288);
  });

  it('preserves a small true-up across the monthly and topup pools', async () => {
    await pool.query('UPDATE organizations SET monthly_allowance_usd=0.00012, credits_usd=1 WHERE id=$1', [organizationId]);
    const lease = await grant();
    const settled = await settleLease(pool, { leaseId: lease.leaseId!, actualUsd: 0.000148, allowOverdraft: true });
    expect(settled.additionalDebitUsd).toBe(0.000048);
    expect(await balances()).toEqual({ monthly: 0, topup: 0.999972 });
  });

  it('settles an abandoned nominal lease without losing its small charge', async () => {
    const lease = await grant();
    await pool.query("UPDATE credit_leases SET status='abandoned' WHERE lease_id=$1", [lease.leaseId]);
    await settleLease(pool, { leaseId: lease.leaseId!, actualUsd: 0.000048, allowOverdraft: true });
    expect((await balances()).topup).toBe(9.999952);
  });

  it.each([0, -1])('fully refunds a zero or negative reported cost (%s)', async (actualUsd) => {
    const lease = await grant();
    const settled = await settleLease(pool, { leaseId: lease.leaseId!, actualUsd, allowOverdraft: true });
    expect(settled.chargedUsd).toBe(0);
    expect(settled.refundedUsd).toBe(0.0001);
    expect((await balances()).topup).toBe(10);
  });

  it('retains charges down to eight decimal places', async () => {
    const lease = await grant();
    const settled = await settleLease(pool, { leaseId: lease.leaseId!, actualUsd: 0.00000001, allowOverdraft: true });
    expect(settled.refundedUsd).toBe(0.00009999);
    expect((await balances()).topup).toBe(9.99999999);
    const stored = await pool.query('SELECT settled_amount_usd FROM credit_leases WHERE lease_id=$1', [lease.leaseId]);
    expect(Number(stored.rows[0].settled_amount_usd)).toBe(0.00000001);
  });

  it('preserves a fractional grant, its split, and a replay of its reservation', async () => {
    await pool.query('UPDATE organizations SET monthly_allowance_usd=0.00004, credits_usd=1 WHERE id=$1', [organizationId]);
    const reservationId = randomUUID();
    const first = await grant(0.00014823, reservationId);
    expect(first.amountGranted).toBe(0.00014823);
    expect(await balances()).toEqual({ monthly: 0, topup: 0.99989177 });
    expect((await grant(0.00014823, reservationId)).leaseId).toBe(first.leaseId);
    expect(await balances()).toEqual({ monthly: 0, topup: 0.99989177 });
    await settleLease(pool, { leaseId: first.leaseId!, actualUsd: 0, allowOverdraft: true });
    expect(await balances()).toEqual({ monthly: 0.00004, topup: 1 });
  });

  it('normalizes the recorded and debited charge to the same precision', async () => {
    const lease = await grant();
    const settled = await settleLease(pool, { leaseId: lease.leaseId!, actualUsd: 0.000048006, allowOverdraft: true });
    expect(settled.chargedUsd).toBe(0.00004801);
    expect(settled.refundedUsd).toBe(0.00005199);
    expect((await balances()).topup).toBe(9.99995199);
  });

  it('retains legacy clamping when the reported charge exceeds the reservation', async () => {
    const lease = await grant();
    const settled = await settleLease(pool, { leaseId: lease.leaseId!, actualUsd: 1 });
    expect(settled.chargedUsd).toBe(0.0001);
    expect(settled.additionalDebitUsd).toBe(0);
    expect(settled.refundedUsd).toBe(0);
    expect((await balances()).topup).toBe(9.9999);
  });

  it.each([
    { estimate: 0.00030000000000000003, wantGrant: 0.0003, wantBalance: 9.9997 },
    { estimate: 0.110678264, wantGrant: 0.11067826, wantBalance: 9.88932174 },
  ])('admits a fully funded estimate of $estimate after normalizing its precision', async (test) => {
    const lease = await acquireForEstimatedCost(pool, userId, organizationId, 'test', test.estimate, 60);
    expect(lease.amountGrantedUsd).toBe(test.wantGrant);
    expect((await balances()).topup).toBe(test.wantBalance);
  });

  it('admits fully funded actor reservations after normalizing computed rates', async () => {
    const lease = await reserveActorCredits(pool, {
      userId, organizationId, region: 'test', recordingUsdPerSecond: 0.00000123456789,
      transcriptionUsdPerSecond: 0, transcript: false, markupPct: 20,
    });
    expect(lease.amountGrantedUsd).toBe(0.00044444);
    expect((await balances()).topup).toBe(9.99955556);
  });

  it('reclaims a fractional split reservation without losing either original portion', async () => {
    await pool.query('UPDATE organizations SET monthly_allowance_usd=0.00000001, credits_usd=1 WHERE id=$1', [organizationId]);
    const lease = await grant(0.00014823);
    await pool.query("UPDATE credit_leases SET expires_at=now()-interval '60 seconds' WHERE lease_id=$1", [lease.leaseId]);
    const reclaimed = await reclaimExpiredLeases(pool, 30);
    expect(reclaimed.reclaimed).toBe(1);
    expect(await balances()).toEqual({ monthly: 0.00000001, topup: 1 });
  });

  it('widens usage costs and monthly-reset snapshots without losing small values', async () => {
    await pool.query('INSERT INTO ai_usage_logs VALUES (0.00000004, 0.00000005, 0.00000005)');
    await pool.query('INSERT INTO monthly_credit_resets VALUES (0.000048)');
    const usage = await pool.query('SELECT * FROM ai_usage_logs');
    expect(Number(usage.rows[0].provider_cost_usd)).toBe(0.00000004);
    expect(Number(usage.rows[0].charged_credits_usd)).toBe(0.00000005);
    expect(Number(usage.rows[0].cost_usd)).toBe(0.00000005);
    const reset = await pool.query('SELECT previous_unspent_usd FROM monthly_credit_resets');
    expect(Number(reset.rows[0].previous_unspent_usd)).toBe(0.000048);
    const legacy = await pool.query('SELECT credits_usd FROM organizations WHERE id=$1', [legacyOrganizationId]);
    expect(Number(legacy.rows[0].credits_usd)).toBe(10.1234);
  });
});
