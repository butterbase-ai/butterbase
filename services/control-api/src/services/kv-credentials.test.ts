import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { KvCredentialsService } from './kv-credentials.js';

const PLATFORM_URL =
  process.env.NEON_PLATFORM_PRIMARY_URL ??
  'postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control';

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === '1';
const describeDb = RUN_DB_TESTS ? describe : describe.skip;

let pool: pg.Pool;
let svc: KvCredentialsService;

beforeAll(async () => {
  if (!RUN_DB_TESTS) return;
  pool = new pg.Pool({ connectionString: PLATFORM_URL });
});

afterAll(async () => {
  if (!RUN_DB_TESTS) return;
  await pool.query(`DELETE FROM app_kv_credentials WHERE app_id LIKE 'kv-test-%'`);
  await pool.end();
});

beforeEach(async () => {
  if (!RUN_DB_TESTS) return;
  svc = new KvCredentialsService(pool);
  await pool.query(`DELETE FROM app_kv_credentials WHERE app_id LIKE 'kv-test-%'`);
});

function createTestApp(_region = 'us'): { id: string } {
  const id = `kv-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return { id };
}

// These tests exercise the kv-credentials provisioning piece in isolation.
// Since migration 061, the apps table no longer lives on controlDb; migration 073
// created app_kv_credentials on controlDb with no FK to apps. The tests below
// validate that KV credential provisioning works transactionally on controlDb.
describeDb('KV credential transactional behaviour', () => {
  it('provisions a KV credential atomically within a transaction', async () => {
    const appId = `kv-test-${Date.now()}-autoprov`;
    const region = 'us';
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const kvSvc = new KvCredentialsService(client);
      await kvSvc.provision(appId, region);
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const { rows } = await pool.query(
      'SELECT region, redis_password FROM app_kv_credentials WHERE app_id = $1',
      [appId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].region).toBe(region);
    expect(rows[0].redis_password).toMatch(/^[a-f0-9]{48,}$/);
  });

  it('rolls back kv credential when control-plane transaction is aborted', async () => {
    const appId = `kv-test-${Date.now()}-rollback`;
    const region = 'us';
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const kvSvc = new KvCredentialsService(client);
      await kvSvc.provision(appId, region);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    const { rows } = await pool.query(
      'SELECT region FROM app_kv_credentials WHERE app_id = $1',
      [appId],
    );
    expect(rows).toHaveLength(0);
  });
});

describeDb('KvCredentialsService', () => {
  it('provisions a credential row with a random password', async () => {
    const app = createTestApp('us');
    const cred = await svc.provision(app.id, 'us');
    expect(cred.app_id).toBe(app.id);
    expect(cred.region).toBe('us');
    expect(cred.redis_password).toMatch(/^[a-f0-9]{48,}$/);
  });

  it('is idempotent — provision twice returns the same password', async () => {
    const app = createTestApp('us');
    const a = await svc.provision(app.id, 'us');
    const b = await svc.provision(app.id, 'us');
    expect(a.redis_password).toBe(b.redis_password);
  });

  it('lookup returns null for unknown app', async () => {
    const cred = await svc.lookup('app_does_not_exist');
    expect(cred).toBeNull();
  });

  it('rotate replaces the password and bumps rotated_at', async () => {
    const app = createTestApp('us');
    const before = await svc.provision(app.id, 'us');
    await new Promise((r) => setTimeout(r, 5));
    const after = await svc.rotate(app.id);
    expect(after.redis_password).not.toBe(before.redis_password);
    expect(after.rotated_at.getTime()).toBeGreaterThan(before.rotated_at.getTime());
  });

  it('provisions also mints a kv_function_key (48+ hex chars, distinct from redis_password)', async () => {
    const app = createTestApp('us');
    const cred = await svc.provision(app.id, 'us');
    expect(cred.kv_function_key).toMatch(/^[a-f0-9]{48,}$/);
    expect(cred.kv_function_key).not.toBe(cred.redis_password);
  });

  it('rotate preserves kv_function_key by default', async () => {
    const app = createTestApp('us');
    const before = await svc.provision(app.id, 'us');
    const after = await svc.rotate(app.id);
    expect(after.kv_function_key).toBe(before.kv_function_key);
    expect(after.redis_password).not.toBe(before.redis_password);
  });
});

describeDb('resolveFunctionKeyWithOwner', () => {
  let testOwnerId: string;
  let testOrgId: string;
  let testAppId: string;
  let otherAppId: string;

  beforeAll(async () => {
    if (!RUN_DB_TESTS) return;
    // Post-Plan-05 platform_users.personal_organization_id is NOT NULL, so
    // seed the org first, then the user pointing at it, then the owner
    // membership row. Mirrors seedUser() in test-helpers/control-db.ts.
    testOwnerId = randomUUID();
    const email = `kv-owner-${testOwnerId}@kv-test.example.com`;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const orgRes = await client.query<{ id: string }>(
        `INSERT INTO organizations (owner_id, name, personal, plan_id, credits_usd, auto_refill_enabled, account_status)
         VALUES ($1, $2, true, 'playground', 0, false, 'active')
         RETURNING id`,
        [testOwnerId, `kv-test org ${testOwnerId}`],
      );
      testOrgId = orgRes.rows[0].id;
      await client.query(
        `INSERT INTO platform_users (id, email, created_at, personal_organization_id, account_status, plan_id)
         VALUES ($1, $2, now(), $3, 'active', 'playground')`,
        [testOwnerId, email, testOrgId],
      );
      await client.query(
        `INSERT INTO organization_members (organization_id, user_id, role, joined_at)
         VALUES ($1, $2, 'owner', now())
         ON CONFLICT (organization_id, user_id) DO NOTHING`,
        [testOrgId, testOwnerId],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // Register two apps in org_app_index (the control-DB owner-lookup table;
    // the `apps` table itself lives on the runtime plane and is not present
    // on controlDb. resolveFunctionKeyWithOwner MUST NOT reference `apps`.
    // See runtime-plane migration 061 and the 2026-07-05 regression that
    // reintroduced the JOIN and broke every ctx.invoke → function_key auth.
    testAppId = `kv-test-owner-${Date.now()}-a`;
    otherAppId = `kv-test-owner-${Date.now()}-b`;
    await pool.query(
      `INSERT INTO org_app_index (app_id, organization_id, region)
       VALUES ($1, $3, 'us'),
              ($2, $3, 'us')`,
      [testAppId, otherAppId, testOrgId],
    );
  });

  afterAll(async () => {
    if (!RUN_DB_TESTS) return;
    await pool.query(`DELETE FROM app_kv_credentials WHERE app_id IN ($1, $2)`, [
      testAppId,
      otherAppId,
    ]);
    await pool.query(`DELETE FROM org_app_index WHERE app_id IN ($1, $2)`, [
      testAppId,
      otherAppId,
    ]);
    await pool.query(`DELETE FROM organization_members WHERE organization_id = $1`, [testOrgId]);
    await pool.query(`DELETE FROM platform_users WHERE id = $1`, [testOwnerId]);
    await pool.query(`DELETE FROM organizations WHERE id = $1`, [testOrgId]);
  });

  it('returns { owner_id, app_id, organization_id } when the key matches the app', async () => {
    const cred = await svc.provision(testAppId, 'us-east-1');
    const result = await svc.resolveFunctionKeyWithOwner(cred.kv_function_key, testAppId);
    expect(result).not.toBeNull();
    expect(result!.app_id).toBe(testAppId);
    expect(result!.owner_id).toBe(testOwnerId);
    // organization_id must be sourced from org_app_index (control-plane), not
    // apps (runtime-plane). If a future edit reintroduces `JOIN apps`, this
    // whole method throws `relation "apps" does not exist` on the control DB
    // and the assertion below never runs — but the query above will already
    // have thrown, failing the test. That's the regression guard.
    expect(result!.organization_id).toBe(testOrgId);
  });

  it('returns null when the key is correct but for a different app', async () => {
    const cred = await svc.provision(testAppId, 'us-east-1');
    const result = await svc.resolveFunctionKeyWithOwner(cred.kv_function_key, otherAppId);
    expect(result).toBeNull();
  });

  it('returns null on a junk token', async () => {
    const result = await svc.resolveFunctionKeyWithOwner('not-a-real-key', testAppId);
    expect(result).toBeNull();
  });
});
