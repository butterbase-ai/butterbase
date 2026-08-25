import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { queryPaidConversion, writePaidConversionSnapshot } from './paid-conversion.js';

// Real-Postgres test. The conversion figures are pure SQL semantics — who counts
// as internal, which subscription states count as paying — so a mocked query
// layer would assert nothing about the thing that can actually break.
//
// Every fixture is created inside a transaction that is rolled back at the end,
// and assertions are on the DELTA from a baseline measured in the same
// transaction, so the test is correct regardless of what else lives in the
// shared control-plane test DB.

const pool = new pg.Pool({
  connectionString:
    process.env.CONTROL_TEST_DATABASE_URL ??
    'postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control',
});

let client: pg.PoolClient;

// Every real user has a personal org (platform_users.personal_organization_id
// is NOT NULL, FK to organizations), and organizations.owner_id points back at
// the user. Creating one means breaking the cycle: org first with a placeholder
// owner, then the user, then point the org at its owner. owner_id has no FK,
// which is what makes the placeholder legal — and is also why prod contains
// orgs whose owner no longer exists.
const PLACEHOLDER_OWNER = '00000000-0000-4000-8000-000000000001';

interface Fixture {
  userId: string;
  orgId: string;
}

async function mkUser(email: string, isAdmin = false): Promise<Fixture> {
  const org = await client.query(
    `INSERT INTO organizations (name, owner_id, personal) VALUES ($1, $2, true) RETURNING id`,
    [`${email} personal`, PLACEHOLDER_OWNER],
  );
  const orgId = org.rows[0].id;
  const user = await client.query(
    `INSERT INTO platform_users (email, is_admin, personal_organization_id)
     VALUES ($1, $2, $3) RETURNING id`,
    [email, isAdmin, orgId],
  );
  const userId = user.rows[0].id;
  await client.query(`UPDATE organizations SET owner_id = $1 WHERE id = $2`, [userId, orgId]);
  return { userId, orgId };
}

async function mkOrg(ownerId: string, name: string): Promise<string> {
  const r = await client.query(
    `INSERT INTO organizations (name, owner_id) VALUES ($1, $2) RETURNING id`,
    [name, ownerId],
  );
  return r.rows[0].id;
}

async function mkSub(
  orgId: string,
  userId: string,
  planId: string,
  status: string,
  cancelAt: string | null = null,
): Promise<void> {
  await client.query(
    `INSERT INTO subscriptions (organization_id, user_id, plan_id, status, cancel_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [orgId, userId, planId, status, cancelAt],
  );
}

beforeAll(async () => {
  client = await pool.connect();
  await client.query('BEGIN');
});

afterAll(async () => {
  await client.query('ROLLBACK');
  client.release();
  await pool.end();
});

describe('queryPaidConversion', () => {
  it('counts an external owner with an active launch sub as paying', async () => {
    const before = await queryPaidConversion(client);

    const u = await mkUser('customer-active@example.com');
    await mkSub(u.orgId, u.userId, 'launch', 'active');

    const after = await queryPaidConversion(client);

    expect(after.payingUsers - before.payingUsers).toBe(1);
    expect(after.payingOrgs - before.payingOrgs).toBe(1);
    expect(after.eligibleUsers - before.eligibleUsers).toBe(1);
    expect(after.eligibleOrgs - before.eligibleOrgs).toBe(1);
  });

  it('excludes an is_admin owner from both numerator and denominator', async () => {
    const before = await queryPaidConversion(client);

    const u = await mkUser('staff-admin@example.com', true);
    await mkSub(u.orgId, u.userId, 'launch', 'active');

    const after = await queryPaidConversion(client);

    expect(after.payingUsers - before.payingUsers).toBe(0);
    expect(after.eligibleUsers - before.eligibleUsers).toBe(0);
    expect(after.payingOrgs - before.payingOrgs).toBe(0);
    expect(after.eligibleOrgs - before.eligibleOrgs).toBe(0);
  });

  it('excludes an @butterbase.ai owner even when not flagged is_admin', async () => {
    const before = await queryPaidConversion(client);

    const u = await mkUser('contractor@butterbase.ai', false);
    await mkSub(u.orgId, u.userId, 'launch', 'active');

    const after = await queryPaidConversion(client);

    expect(after.payingUsers - before.payingUsers).toBe(0);
    expect(after.eligibleUsers - before.eligibleUsers).toBe(0);
    expect(after.eligibleOrgs - before.eligibleOrgs).toBe(0);
  });

  it('excludes a portal-cancelled sub from strict but keeps the owner eligible', async () => {
    const before = await queryPaidConversion(client);

    const u = await mkUser('portal-cancelled@example.com');
    await mkSub(u.orgId, u.userId, 'launch', 'active', '2099-01-01T00:00:00Z');

    const after = await queryPaidConversion(client);

    expect(after.payingUsers - before.payingUsers).toBe(0);
    expect(after.payingOrgs - before.payingOrgs).toBe(0);
    // Still a real external user with a real org, so the denominator grows.
    expect(after.eligibleUsers - before.eligibleUsers).toBe(1);
    expect(after.eligibleOrgs - before.eligibleOrgs).toBe(1);
  });

  it('counts past_due in broad but not in strict', async () => {
    const before = await queryPaidConversion(client);

    const u = await mkUser('dunning@example.com');
    await mkSub(u.orgId, u.userId, 'launch', 'past_due');

    const after = await queryPaidConversion(client);

    expect(after.payingUsers - before.payingUsers).toBe(0);
    expect(after.payingOrgs - before.payingOrgs).toBe(0);
    expect(after.broadPayingUsers - before.broadPayingUsers).toBe(1);
    expect(after.broadPayingOrgs - before.broadPayingOrgs).toBe(1);
  });

  it('does not count playground or enterprise as paying', async () => {
    const before = await queryPaidConversion(client);

    const free = await mkUser('free-user@example.com');
    await mkSub(free.orgId, free.userId, 'playground', 'active');

    const ent = await mkUser('ent-user@example.com');
    await mkSub(ent.orgId, ent.userId, 'enterprise', 'active');

    const after = await queryPaidConversion(client);

    expect(after.payingUsers - before.payingUsers).toBe(0);
    expect(after.broadPayingUsers - before.broadPayingUsers).toBe(0);
    expect(after.eligibleUsers - before.eligibleUsers).toBe(2);
    expect(after.eligibleOrgs - before.eligibleOrgs).toBe(2);
  });

  it('counts an owner of two paying orgs once as a user but twice as orgs', async () => {
    const before = await queryPaidConversion(client);

    const u = await mkUser('multi-org@example.com');
    const a = await mkOrg(u.userId, 'Multi A');
    const b = await mkOrg(u.userId, 'Multi B');
    await mkSub(a, u.userId, 'launch', 'active');
    await mkSub(b, u.userId, 'certified', 'active');

    const after = await queryPaidConversion(client);

    expect(after.payingUsers - before.payingUsers).toBe(1);
    expect(after.payingOrgs - before.payingOrgs).toBe(2);
    // personal org (unpaid) + the two paying orgs
    expect(after.eligibleOrgs - before.eligibleOrgs).toBe(3);
  });

  it('ignores an org whose owner_id has no platform_users row', async () => {
    // organizations.owner_id has no FK, and prod contains 4 such orphans.
    const before = await queryPaidConversion(client);

    await mkOrg('00000000-0000-4000-8000-0000000000ff', 'Orphaned Owner Org');

    const after = await queryPaidConversion(client);

    expect(after.eligibleOrgs - before.eligibleOrgs).toBe(0);
    expect(after.payingOrgs - before.payingOrgs).toBe(0);
  });

  it('reports percentages derived from the counts', async () => {
    const r = await queryPaidConversion(client);

    expect(r.payingUsersPct).toBeCloseTo((r.payingUsers / r.eligibleUsers) * 100, 6);
    expect(r.payingOrgsPct).toBeCloseTo((r.payingOrgs / r.eligibleOrgs) * 100, 6);
  });
});

describe('writePaidConversionSnapshot', () => {
  const DAY = '2031-03-04';

  it('records the current conversion figures for the given date', async () => {
    const expected = await queryPaidConversion(client);

    await writePaidConversionSnapshot(client, DAY);

    const { rows } = await client.query(
      `SELECT * FROM paid_conversion_snapshots WHERE snapshot_date = $1`,
      [DAY],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].paying_users).toBe(expected.payingUsers);
    expect(rows[0].eligible_users).toBe(expected.eligibleUsers);
    expect(rows[0].paying_orgs).toBe(expected.payingOrgs);
    expect(rows[0].eligible_orgs).toBe(expected.eligibleOrgs);
    expect(rows[0].broad_paying_users).toBe(expected.broadPayingUsers);
    expect(rows[0].broad_paying_orgs).toBe(expected.broadPayingOrgs);
  });

  it('is idempotent: a second run on the same date updates rather than duplicates', async () => {
    await writePaidConversionSnapshot(client, DAY);

    // A new paying customer appears after the first snapshot of the day.
    const u = await mkUser('late-signup@example.com');
    await mkSub(u.orgId, u.userId, 'launch', 'active');

    await writePaidConversionSnapshot(client, DAY);

    const { rows } = await client.query(
      `SELECT * FROM paid_conversion_snapshots WHERE snapshot_date = $1`,
      [DAY],
    );
    expect(rows).toHaveLength(1);
    const live = await queryPaidConversion(client);
    expect(rows[0].paying_users).toBe(live.payingUsers);
  });
});
