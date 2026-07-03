import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import pg from 'pg';
import moveAppRoutes from './move.js';

const PLATFORM_URL =
  process.env.NEON_PLATFORM_PRIMARY_URL ??
  'postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control';

let app: ReturnType<typeof Fastify>;
let pool: pg.Pool;
let userId: string;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: PLATFORM_URL });
  const r = await pool.query(
    `INSERT INTO platform_users (id, email, account_status, plan_id)
     VALUES (gen_random_uuid(), 'moveapi-test@example.com', 'active', 'launch')
     ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
     RETURNING id`,
  );
  userId = r.rows[0].id;
  await pool.query(
    `INSERT INTO org_app_index (app_id, organization_id, region)
     VALUES ('app-move-test', (SELECT personal_organization_id FROM platform_users WHERE id = $1), 'us-east-1')
     ON CONFLICT (app_id) DO UPDATE SET region = EXCLUDED.region`,
    [userId],
  );

  app = Fastify();
  app.decorate('controlDb', pool);
  // Inject auth so requireUserId finds a userId
  app.addHook('preHandler', async (request: any) => {
    request.auth = { userId };
  });
  await app.register(moveAppRoutes);
  await app.ready();
});

afterAll(async () => {
  await pool.query(`DELETE FROM app_migrations WHERE user_id = $1`, [userId]);
  await pool.query(`DELETE FROM org_app_index WHERE app_id = 'app-move-test'`);
  await pool.query(`DELETE FROM platform_users WHERE id = $1`, [userId]);
  await app.close();
  await pool.end();
});

describe('POST /v1/apps/:app_id/move', () => {
  it('creates a migration and returns 202', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/apps/app-move-test/move',
      payload: { dest_region: 'eu-west-1' },
    });
    expect(r.statusCode).toBe(202);
    expect(r.json().status).toBe('queued');
  });

  it('rejects when source and dest regions are equal', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/apps/app-move-test/move',
      payload: { dest_region: 'us-east-1' },
    });
    expect(r.statusCode).toBe(409);
  });

  it('rejects missing dest_region with 400', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/apps/app-move-test/move',
      payload: {},
    });
    expect(r.statusCode).toBe(400);
  });
});

describe('GET /v1/apps/:app_id/migrations/:migration_id', () => {
  it('returns 404 for unknown migration', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/v1/apps/app-move-test/migrations/00000000-0000-0000-0000-000000000000',
    });
    expect(r.statusCode).toBe(404);
  });
});

describe('POST /v1/apps/:app_id/migrations/:migration_id/abort', () => {
  it('returns 404 for unknown migration', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/apps/app-move-test/migrations/00000000-0000-0000-0000-000000000000/abort',
    });
    expect(r.statusCode).toBe(404);
  });
});
