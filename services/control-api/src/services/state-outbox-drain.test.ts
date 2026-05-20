import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { drainOnce, applyVersionToRegion, pruneOldOutboxRows } from './state-outbox-drain.js';
import { writeUserStateChange } from './state-outbox.js';

const PLATFORM_URL = process.env.NEON_PLATFORM_PRIMARY_URL
  ?? 'postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control';
const RUNTIME_URL = process.env.NEON_RUNTIME_PROJECT_ID_US_EAST_1
  ?? 'postgresql://butterbase:butterbase_dev@localhost:5437/butterbase_runtime_us';

let platformPool: pg.Pool;
let runtimePool: pg.Pool;
let testUserId: string;

beforeAll(async () => {
  platformPool = new pg.Pool({ connectionString: PLATFORM_URL });
  runtimePool = new pg.Pool({ connectionString: RUNTIME_URL });
  const ins = await platformPool.query(
    `INSERT INTO platform_users (id, email, account_status, plan_id)
     VALUES (gen_random_uuid(), 'drain-test@example.com', 'active', 'playground')
     ON CONFLICT (email) DO UPDATE SET email=EXCLUDED.email RETURNING id`
  );
  testUserId = ins.rows[0].id;
});

afterAll(async () => {
  await platformPool.query(`DELETE FROM user_state_outbox WHERE user_id = $1`, [testUserId]);
  await runtimePool.query(`DELETE FROM user_billing_state WHERE user_id = $1`, [testUserId]);
  await platformPool.query(`DELETE FROM platform_users WHERE id = $1`, [testUserId]);
  await platformPool.end();
  await runtimePool.end();
});

beforeEach(async () => {
  await platformPool.query(`DELETE FROM user_state_outbox WHERE user_id = $1`, [testUserId]);
  await runtimePool.query(`DELETE FROM user_billing_state WHERE user_id = $1`, [testUserId]);
});

describe('applyVersionToRegion', () => {
  it('upserts user_billing_state with the new version', async () => {
    const { version } = await writeUserStateChange(platformPool, testUserId, { account_status: 'soft_locked' });
    await applyVersionToRegion(runtimePool, testUserId, version, { account_status: 'soft_locked' });
    const r = await runtimePool.query(`SELECT account_status, last_outbox_version FROM user_billing_state WHERE user_id = $1`, [testUserId]);
    expect(r.rows[0].account_status).toBe('soft_locked');
    expect(parseInt(r.rows[0].last_outbox_version, 10)).toBe(version);
  });

  it('skips an older version (idempotent / out-of-order safe)', async () => {
    const { version: v1 } = await writeUserStateChange(platformPool, testUserId, { plan_id: 'launch' });
    const { version: v2 } = await writeUserStateChange(platformPool, testUserId, { plan_id: 'certified' });
    await applyVersionToRegion(runtimePool, testUserId, v2, { plan_id: 'certified' });
    await applyVersionToRegion(runtimePool, testUserId, v1, { plan_id: 'launch' });
    const r = await runtimePool.query(`SELECT plan_id, last_outbox_version FROM user_billing_state WHERE user_id = $1`, [testUserId]);
    expect(r.rows[0].plan_id).toBe('certified');
    expect(parseInt(r.rows[0].last_outbox_version, 10)).toBe(v2);
  });
});

describe('drainOnce', () => {
  it('marks a row done when all regions have applied', async () => {
    await writeUserStateChange(platformPool, testUserId, { plan_id: 'launch' });
    const result = await drainOnce({
      platformPool,
      runtimePoolsByRegion: { 'us-east-1': runtimePool },
    });
    expect(result.processed).toBeGreaterThan(0);
    const o = await platformPool.query(`SELECT applied_to_regions, done_at FROM user_state_outbox WHERE user_id = $1`, [testUserId]);
    expect(o.rows[0].applied_to_regions).toContain('us-east-1');
    expect(o.rows[0].done_at).not.toBeNull();
  });

  it('returns 0 processed when no pending rows', async () => {
    const result = await drainOnce({
      platformPool,
      runtimePoolsByRegion: { 'us-east-1': runtimePool },
    });
    expect(result.processed).toBe(0);
  });
});

describe('pruneOldOutboxRows', () => {
  it('deletes rows whose done_at is older than retention', async () => {
    await writeUserStateChange(platformPool, testUserId, { account_status: 'active' });
    await drainOnce({ platformPool, runtimePoolsByRegion: { 'us-east-1': runtimePool } });
    // Force done_at to 8 days ago
    await platformPool.query(
      `UPDATE user_state_outbox SET done_at = now() - interval '8 days' WHERE user_id = $1`,
      [testUserId]
    );
    const result = await pruneOldOutboxRows(platformPool, 7);
    expect(result.deleted).toBeGreaterThanOrEqual(1);
    const r = await platformPool.query(`SELECT count(*)::int AS c FROM user_state_outbox WHERE user_id = $1`, [testUserId]);
    expect(r.rows[0].c).toBe(0);
  });

  it('does not delete rows newer than retention', async () => {
    await writeUserStateChange(platformPool, testUserId, { account_status: 'active' });
    await drainOnce({ platformPool, runtimePoolsByRegion: { 'us-east-1': runtimePool } });
    const result = await pruneOldOutboxRows(platformPool, 7);
    expect(result.deleted).toBe(0);
  });
});
