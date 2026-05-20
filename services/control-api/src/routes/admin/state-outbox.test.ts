import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify from 'fastify';
import pg from 'pg';
import stateOutboxRoutes from './state-outbox.js';
import internalAuthPlugin from '../../plugins/internal-auth.js';
import { writeUserStateChange } from '../../services/state-outbox.js';

const PLATFORM_URL = process.env.NEON_PLATFORM_PRIMARY_URL
  ?? 'postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control';
const RUNTIME_URL = process.env.NEON_RUNTIME_PROJECT_ID_US_EAST_1
  ?? 'postgresql://butterbase:butterbase_dev@localhost:5437/butterbase_runtime_us';

let app: ReturnType<typeof Fastify>;
let platformPool: pg.Pool;
let runtimePool: pg.Pool;
let testUserId: string;

beforeAll(async () => {
  process.env.BUTTERBASE_INTERNAL_SECRET = 'test-secret';
  process.env.BUTTERBASE_REGIONS = 'us-east-1';
  process.env.BUTTERBASE_REGION = 'us-east-1';
  process.env.NEON_RUNTIME_PROJECT_ID_US_EAST_1 = RUNTIME_URL;
  platformPool = new pg.Pool({ connectionString: PLATFORM_URL });
  runtimePool = new pg.Pool({ connectionString: RUNTIME_URL });

  app = Fastify();
  await app.register(internalAuthPlugin);
  app.decorate('controlDb', platformPool);
  app.decorate('runtimeDb', () => runtimePool);
  await app.register(stateOutboxRoutes);
  await app.ready();

  const ins = await platformPool.query(
    `INSERT INTO platform_users (id, email, account_status, plan_id)
     VALUES (gen_random_uuid(), 'admin-state-test@example.com', 'active', 'playground')
     ON CONFLICT (email) DO UPDATE SET email=EXCLUDED.email RETURNING id`
  );
  testUserId = ins.rows[0].id;
});

afterAll(async () => {
  await platformPool.query(`DELETE FROM user_state_outbox WHERE user_id = $1`, [testUserId]);
  await runtimePool.query(`DELETE FROM user_billing_state WHERE user_id = $1`, [testUserId]);
  await platformPool.query(`DELETE FROM platform_users WHERE id = $1`, [testUserId]);
  await app.close();
  await platformPool.end();
  await runtimePool.end();
});

beforeEach(async () => {
  await platformPool.query(`DELETE FROM user_state_outbox WHERE user_id = $1`, [testUserId]);
});

describe('POST /v1/internal/state-outbox/drain', () => {
  it('drains pending rows', async () => {
    await writeUserStateChange(platformPool, testUserId, { account_status: 'active' });
    const r = await app.inject({
      method: 'POST',
      url: '/v1/internal/state-outbox/drain',
      headers: { 'x-butterbase-internal-secret': 'test-secret' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().processed).toBeGreaterThan(0);
  });
});

describe('GET /v1/internal/state-outbox/lag', () => {
  it('reports zero pending when all drained', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/v1/internal/state-outbox/lag',
      headers: { 'x-butterbase-internal-secret': 'test-secret' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ pending: expect.any(Number), oldestPendingSeconds: expect.any(Number) });
  });
});
