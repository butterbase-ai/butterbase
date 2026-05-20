import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import {
  createMigration,
  getMigration,
  advanceStep,
  recordError,
  markCompleted,
  markAborted,
  HAPPY_PATH_ORDER,
} from './migration-store.js';

const PLATFORM_URL = process.env.NEON_PLATFORM_PRIMARY_URL
  ?? 'postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control';

let pool: pg.Pool;
let testUserId: string;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: PLATFORM_URL });
  const r = await pool.query(
    `INSERT INTO platform_users (id, email, account_status, plan_id)
     VALUES (gen_random_uuid(), 'migstore-test@example.com', 'active', 'launch')
     ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id`
  );
  testUserId = r.rows[0].id;
});
afterAll(async () => {
  await pool.query(`DELETE FROM app_migrations WHERE user_id = $1`, [testUserId]);
  await pool.query(`DELETE FROM platform_users WHERE id = $1`, [testUserId]);
  await pool.end();
});
beforeEach(async () => {
  await pool.query(`DELETE FROM app_migrations WHERE user_id = $1`, [testUserId]);
});

describe('createMigration', () => {
  it('creates a row in requested state', async () => {
    const id = await createMigration(pool, {
      appId: 'app-a', userId: testUserId, sourceRegion: 'us-east-1', destRegion: 'eu-west-1',
    });
    const m = await getMigration(pool, id);
    expect(m).toMatchObject({ app_id: 'app-a', current_step: 'requested', retry_count: 0 });
  });

  it('refuses a second active migration for the same app', async () => {
    await createMigration(pool, { appId: 'app-a', userId: testUserId, sourceRegion: 'us-east-1', destRegion: 'eu-west-1' });
    await expect(createMigration(pool, {
      appId: 'app-a', userId: testUserId, sourceRegion: 'us-east-1', destRegion: 'eu-west-1',
    })).rejects.toThrow();
  });
});

describe('advanceStep', () => {
  it('advances to the next step in HAPPY_PATH_ORDER and resets retry_count', async () => {
    const id = await createMigration(pool, { appId: 'app-b', userId: testUserId, sourceRegion: 'us-east-1', destRegion: 'eu-west-1' });
    await advanceStep(pool, id, 'reserving_dest', { neon_db_name: 'cust_app_b_dest' });
    const m = await getMigration(pool, id);
    expect(m?.current_step).toBe('reserving_dest');
    expect(m?.dest_resources).toMatchObject({ neon_db_name: 'cust_app_b_dest' });
    expect(m?.retry_count).toBe(0);
  });

  it('rejects an out-of-order transition', async () => {
    const id = await createMigration(pool, { appId: 'app-c', userId: testUserId, sourceRegion: 'us-east-1', destRegion: 'eu-west-1' });
    await expect(advanceStep(pool, id, 'flipping_routing', {})).rejects.toThrow(/illegal transition/);
  });
});

describe('recordError', () => {
  it('increments retry_count and stores last_error', async () => {
    const id = await createMigration(pool, { appId: 'app-d', userId: testUserId, sourceRegion: 'us-east-1', destRegion: 'eu-west-1' });
    await recordError(pool, id, 'Neon API 502');
    const m = await getMigration(pool, id);
    expect(m?.last_error).toBe('Neon API 502');
    expect(m?.retry_count).toBe(1);
  });
});

describe('markCompleted', () => {
  it('sets current_step=completed and completed_at', async () => {
    const id = await createMigration(pool, { appId: 'app-e', userId: testUserId, sourceRegion: 'us-east-1', destRegion: 'eu-west-1' });
    await markCompleted(pool, id);
    const m = await getMigration(pool, id);
    expect(m?.current_step).toBe('completed');
    expect(m?.completed_at).not.toBeNull();
  });
});

describe('HAPPY_PATH_ORDER', () => {
  it('starts at requested and ends at completed', () => {
    expect(HAPPY_PATH_ORDER[0]).toBe('requested');
    expect(HAPPY_PATH_ORDER[HAPPY_PATH_ORDER.length - 1]).toBe('completed');
  });
});
