import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { writeUserStateChange, OUTBOX_FIELDS } from './state-outbox.js';

const PLATFORM_URL = process.env.NEON_PLATFORM_PRIMARY_URL
  ?? 'postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control';

let pool: pg.Pool;
let testUserId: string;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: PLATFORM_URL });
  const ins = await pool.query(
    `INSERT INTO platform_users (id, email, account_status, plan_id)
     VALUES (gen_random_uuid(), 'state-outbox-test@example.com', 'active', 'playground')
     ON CONFLICT (email) DO UPDATE SET email=EXCLUDED.email RETURNING id`
  );
  testUserId = ins.rows[0].id;
});

afterAll(async () => {
  await pool.query(`DELETE FROM user_state_outbox WHERE user_id = $1`, [testUserId]);
  await pool.query(`DELETE FROM platform_users WHERE id = $1`, [testUserId]);
  await pool.end();
});

beforeEach(async () => {
  await pool.query(`DELETE FROM user_state_outbox WHERE user_id = $1`, [testUserId]);
});

describe('writeUserStateChange', () => {
  it('writes platform_users update + outbox row in one transaction', async () => {
    const result = await writeUserStateChange(pool, testUserId, { account_status: 'soft_locked' });
    expect(result.version).toBeGreaterThan(0);

    const u = await pool.query(`SELECT account_status FROM platform_users WHERE id = $1`, [testUserId]);
    expect(u.rows[0].account_status).toBe('soft_locked');

    const o = await pool.query(`SELECT fields_changed, version FROM user_state_outbox WHERE user_id = $1`, [testUserId]);
    expect(o.rows.length).toBe(1);
    expect(o.rows[0].fields_changed).toEqual({ account_status: 'soft_locked' });
    expect(parseInt(o.rows[0].version, 10)).toBe(result.version);
  });

  it('supports multiple fields in one call', async () => {
    await writeUserStateChange(pool, testUserId, { plan_id: 'launch', spending_cap_usd: 50 });
    const u = await pool.query(`SELECT plan_id, spending_cap_usd FROM platform_users WHERE id = $1`, [testUserId]);
    expect(u.rows[0].plan_id).toBe('launch');
    expect(parseFloat(u.rows[0].spending_cap_usd)).toBe(50);
    const o = await pool.query(`SELECT fields_changed FROM user_state_outbox WHERE user_id = $1`, [testUserId]);
    expect(o.rows[0].fields_changed).toEqual({ plan_id: 'launch', spending_cap_usd: 50 });
  });

  it('rejects unknown fields', async () => {
    // @ts-expect-error invalid field name to test runtime guard
    await expect(writeUserStateChange(pool, testUserId, { foo: 'bar' })).rejects.toThrow(/unsupported field/i);
  });

  it('rolls back if the platform_users update fails', async () => {
    await expect(
      writeUserStateChange(pool, '00000000-0000-0000-0000-000000000000', { account_status: 'active' })
    ).rejects.toThrow();
    const o = await pool.query(`SELECT count(*)::int AS c FROM user_state_outbox WHERE user_id = $1`,
      ['00000000-0000-0000-0000-000000000000']);
    expect(o.rows[0].c).toBe(0);
  });

  it('exports the canonical field allow-list', () => {
    expect(OUTBOX_FIELDS).toEqual(['account_status', 'plan_id', 'spending_cap_usd']);
  });
});
