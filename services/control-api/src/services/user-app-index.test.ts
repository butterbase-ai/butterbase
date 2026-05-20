import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import {
  addUserAppIndex,
  removeUserAppIndex,
  updateUserAppIndexRegion,
  listUserApps,
} from './user-app-index.js';

const PLATFORM_URL = process.env.NEON_PLATFORM_PRIMARY_URL
  ?? 'postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control';

let pool: pg.Pool;
let testUserId: string;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: PLATFORM_URL });
  const r = await pool.query(
    `INSERT INTO platform_users (id, email, account_status, plan_id)
     VALUES (gen_random_uuid(), 'uai-test@example.com', 'active', 'playground')
     ON CONFLICT (email) DO UPDATE SET email=EXCLUDED.email RETURNING id`
  );
  testUserId = r.rows[0].id;
});

afterAll(async () => {
  await pool.query(`DELETE FROM user_app_index WHERE user_id = $1`, [testUserId]);
  await pool.query(`DELETE FROM platform_users WHERE id = $1`, [testUserId]);
  await pool.end();
});

beforeEach(async () => {
  await pool.query(`DELETE FROM user_app_index WHERE user_id = $1`, [testUserId]);
});

describe('addUserAppIndex', () => {
  it('inserts a new row', async () => {
    await addUserAppIndex(pool, { userId: testUserId, appId: 'app-1', region: 'us-east-1', subdomain: 'demo', appName: 'Demo' });
    const apps = await listUserApps(pool, testUserId);
    expect(apps).toHaveLength(1);
    expect(apps[0]).toMatchObject({ app_id: 'app-1', region: 'us-east-1', subdomain: 'demo' });
  });

  it('is idempotent on duplicate insert', async () => {
    await addUserAppIndex(pool, { userId: testUserId, appId: 'app-1', region: 'us-east-1' });
    await addUserAppIndex(pool, { userId: testUserId, appId: 'app-1', region: 'us-east-1' });
    const apps = await listUserApps(pool, testUserId);
    expect(apps).toHaveLength(1);
  });
});

describe('removeUserAppIndex', () => {
  it('deletes the row', async () => {
    await addUserAppIndex(pool, { userId: testUserId, appId: 'app-1', region: 'us-east-1' });
    await removeUserAppIndex(pool, 'app-1');
    const apps = await listUserApps(pool, testUserId);
    expect(apps).toHaveLength(0);
  });

  it('is a no-op for unknown app', async () => {
    await expect(removeUserAppIndex(pool, 'never-existed')).resolves.not.toThrow();
  });
});

describe('updateUserAppIndexRegion', () => {
  it('updates the region of an existing entry', async () => {
    await addUserAppIndex(pool, { userId: testUserId, appId: 'app-1', region: 'us-east-1' });
    await updateUserAppIndexRegion(pool, 'app-1', 'eu-west-1');
    const apps = await listUserApps(pool, testUserId);
    expect(apps[0].region).toBe('eu-west-1');
  });
});

describe('listUserApps', () => {
  it('returns rows for the user, newest first', async () => {
    await addUserAppIndex(pool, { userId: testUserId, appId: 'a', region: 'us-east-1' });
    await new Promise((r) => setTimeout(r, 10));
    await addUserAppIndex(pool, { userId: testUserId, appId: 'b', region: 'us-east-1' });
    const apps = await listUserApps(pool, testUserId);
    expect(apps.map((a) => a.app_id)).toEqual(['b', 'a']);
  });
});
