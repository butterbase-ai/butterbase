import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import pg from 'pg';
import { config } from '../config.js';
import { countAgedUnsettled } from './lease-alerts.js';

const describeDb = process.env.RUN_DB_TESTS ? describe : describe.skip;

describeDb('countAgedUnsettled', () => {
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
        [tmpId, `lease-alerts-test-${suffix}@example.com`, `lease-alerts-test-sub-${suffix}`, testOrgId],
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
  });

  async function insertLease(status: string, expiresAgo: string) {
    const r = await pool.query<{ lease_id: string }>(
      `INSERT INTO credit_leases (user_id, organization_id, region, amount_usd, expires_at, status)
       VALUES ($1, $2, 'us-east-1', 1, now() - interval '${expiresAgo}', $3)
       RETURNING lease_id`,
      [testUserId, testOrgId, status],
    );
    return r.rows[0].lease_id;
  }

  it('counts an abandoned lease whose expiry is older than the window', async () => {
    await insertLease('abandoned', '2 hours');
    const n = await countAgedUnsettled(pool, 3600);
    expect(n).toBe(1);
  });

  it('excludes an abandoned lease that expired more recently than the window', async () => {
    await insertLease('abandoned', '2 hours');
    await insertLease('abandoned', '10 seconds');
    const n = await countAgedUnsettled(pool, 3600);
    expect(n).toBe(1);
  });

  it('excludes settled leases even if old', async () => {
    await insertLease('abandoned', '2 hours');
    await insertLease('settled', '2 hours');
    const n = await countAgedUnsettled(pool, 3600);
    expect(n).toBe(1);
  });

  it('returns 0 when there are no aged-unsettled leases', async () => {
    await insertLease('abandoned', '10 seconds');
    await insertLease('settled', '2 hours');
    const n = await countAgedUnsettled(pool, 3600);
    expect(n).toBe(0);
  });
});
