import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { KvCredentialsService } from './kv-credentials.js';

const PLATFORM_URL =
  process.env.NEON_PLATFORM_PRIMARY_URL ??
  'postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control';

let pool: pg.Pool;
let svc: KvCredentialsService;
let testUserId: string;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: PLATFORM_URL });
  // Create a stable test user for FK references
  const r = await pool.query(
    `INSERT INTO platform_users (id, email, account_status, plan_id)
     VALUES ($1, 'kv-cred-test@example.com', 'active', 'playground')
     ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id`,
    [randomUUID()],
  );
  testUserId = r.rows[0].id;
});

afterAll(async () => {
  await pool.query(`DELETE FROM app_kv_credentials WHERE app_id LIKE 'kv-test-%'`);
  await pool.query(`DELETE FROM apps WHERE id LIKE 'kv-test-%'`);
  await pool.query(`DELETE FROM platform_users WHERE email = 'kv-cred-test@example.com'`);
  await pool.end();
});

beforeEach(async () => {
  svc = new KvCredentialsService(pool);
  await pool.query(`DELETE FROM app_kv_credentials WHERE app_id LIKE 'kv-test-%'`);
  await pool.query(`DELETE FROM apps WHERE id LIKE 'kv-test-%'`);
});

async function createTestApp(region = 'us'): Promise<{ id: string }> {
  const id = `kv-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await pool.query(
    `INSERT INTO apps (id, name, owner_id, db_name, region)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, `KV Test App ${id}`, testUserId, `db_${id}`, region],
  );
  return { id };
}

describe('KvCredentialsService', () => {
  it('provisions a credential row with a random password', async () => {
    const app = await createTestApp('us');
    const cred = await svc.provision(app.id, 'us');
    expect(cred.app_id).toBe(app.id);
    expect(cred.region).toBe('us');
    expect(cred.redis_password).toMatch(/^[a-f0-9]{48,}$/);
  });

  it('is idempotent — provision twice returns the same password', async () => {
    const app = await createTestApp('us');
    const a = await svc.provision(app.id, 'us');
    const b = await svc.provision(app.id, 'us');
    expect(a.redis_password).toBe(b.redis_password);
  });

  it('lookup returns null for unknown app', async () => {
    const cred = await svc.lookup('app_does_not_exist');
    expect(cred).toBeNull();
  });

  it('rotate replaces the password and bumps rotated_at', async () => {
    const app = await createTestApp('us');
    const before = await svc.provision(app.id, 'us');
    await new Promise((r) => setTimeout(r, 5));
    const after = await svc.rotate(app.id);
    expect(after.redis_password).not.toBe(before.redis_password);
    expect(after.rotated_at.getTime()).toBeGreaterThan(before.rotated_at.getTime());
  });
});
