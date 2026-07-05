import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import pg from 'pg';
import internalAuthPlugin from '../../plugins/internal-auth.js';
import visitBeaconRoutes from './visit-beacon.js';
import { seedUser } from '../../__tests__/test-helpers/control-db.js';

const PLATFORM_URL =
  process.env.CONTROL_DB_URL ??
  'postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control';

let app: ReturnType<typeof Fastify>;
let pool: pg.Pool;
let testAppId: string;

beforeAll(async () => {
  process.env.BUTTERBASE_INTERNAL_SECRET = 'test-secret';
  pool = new pg.Pool({ connectionString: PLATFORM_URL });
  app = Fastify();
  app.decorate('controlDb', pool);
  await app.register(internalAuthPlugin);
  await app.register(visitBeaconRoutes);
  await app.ready();

  // Clean up any leftovers from a previous run before seeding.
  const prev = await pool.query<{ id: string }>(
    `SELECT id FROM platform_users WHERE email = 'visit-beacon-test@x.com'`
  );
  if (prev.rows[0]) {
    const prevId = prev.rows[0].id;
    await pool.query(`DELETE FROM platform_users WHERE id = $1`, [prevId]);
    await pool.query(`DELETE FROM organizations WHERE owner_id = $1 AND personal = true`, [prevId]);
  }

  // Seed a platform user + personal org (required by apps.owner_id FK)
  const { id: ownerId } = await seedUser('visit-beacon-test@x.com');

  // Seed a test app — minimal columns only
  testAppId = 'test-visit-beacon-app';
  await pool.query(
    `INSERT INTO apps (id, owner_id) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
    [testAppId, ownerId]
  );
});

afterAll(async () => {
  await pool.query(`DELETE FROM frontend_visit_daily WHERE app_id LIKE 'test-visit-%'`);
  await pool.query(`DELETE FROM apps WHERE id LIKE 'test-visit-%'`);
  // seedUser uses @x.com — the shared cleanup in control-db.ts covers it, but we also
  // clean up explicitly so this test is self-contained.
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM platform_users WHERE email = 'visit-beacon-test@x.com'`
  );
  const userId = rows[0]?.id;
  if (userId) {
    await pool.query(`DELETE FROM platform_users WHERE id = $1`, [userId]);
    await pool.query(`DELETE FROM organizations WHERE owner_id = $1 AND personal = true`, [userId]);
  }
  await app.close();
  await pool.end();
});

const SECRET_HEADER = {
  'x-butterbase-internal-secret': 'test-secret',
  'content-type': 'application/json',
};

describe('POST /v1/internal/visit-beacon', () => {
  it('returns 401 when secret header is missing', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/internal/visit-beacon',
      headers: { 'content-type': 'application/json' },
      payload: { app_id: testAppId, count: 1, unique_hashes: ['a'] },
    });
    expect(r.statusCode).toBe(401);
  });

  it('returns 401 when secret header value is wrong', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/internal/visit-beacon',
      headers: { 'x-butterbase-internal-secret': 'wrong-secret', 'content-type': 'application/json' },
      payload: { app_id: testAppId, count: 1, unique_hashes: ['a'] },
    });
    expect(r.statusCode).toBe(401);
  });

  it('returns 400 on missing required fields', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/internal/visit-beacon',
      headers: SECRET_HEADER,
      payload: { app_id: testAppId },
    });
    expect(r.statusCode).toBe(400);
  });

  it('dedupes unique_hashes within a single batch', async () => {
    const appId = 'test-visit-dedupe';
    await pool.query(
      `INSERT INTO apps (id, owner_id) SELECT $1, owner_id FROM apps WHERE id = $2 ON CONFLICT (id) DO NOTHING`,
      [appId, testAppId]
    );

    const r = await app.inject({
      method: 'POST',
      url: '/v1/internal/visit-beacon',
      headers: SECRET_HEADER,
      payload: { app_id: appId, count: 3, unique_hashes: ['a', 'a', 'b'] },
    });
    expect(r.statusCode).toBe(204);

    const { rows } = await pool.query(
      `SELECT unique_visitor_count FROM frontend_visit_daily WHERE app_id = $1 AND day = CURRENT_DATE`,
      [appId]
    );
    expect(rows[0]?.unique_visitor_count).toBe(2);
  });

  it('accumulates request_count and unique_visitor_count across two batches', async () => {
    const appId = 'test-visit-accumulate';
    await pool.query(
      `INSERT INTO apps (id, owner_id) SELECT $1, owner_id FROM apps WHERE id = $2 ON CONFLICT (id) DO NOTHING`,
      [appId, testAppId]
    );

    // First batch: 5 requests, 3 unique
    const r1 = await app.inject({
      method: 'POST',
      url: '/v1/internal/visit-beacon',
      headers: SECRET_HEADER,
      payload: { app_id: appId, count: 5, unique_hashes: ['x', 'y', 'z'] },
    });
    expect(r1.statusCode).toBe(204);

    // Second batch: 3 requests, 2 unique (different hashes → additive)
    const r2 = await app.inject({
      method: 'POST',
      url: '/v1/internal/visit-beacon',
      headers: SECRET_HEADER,
      payload: { app_id: appId, count: 3, unique_hashes: ['p', 'q'] },
    });
    expect(r2.statusCode).toBe(204);

    const { rows } = await pool.query(
      `SELECT request_count, unique_visitor_count
         FROM frontend_visit_daily
        WHERE app_id = $1 AND day = CURRENT_DATE`,
      [appId]
    );
    expect(rows[0]?.request_count).toBe(8);
    expect(rows[0]?.unique_visitor_count).toBe(5);
  });
});
