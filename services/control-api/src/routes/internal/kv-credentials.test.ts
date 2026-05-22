import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify from 'fastify';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import internalAuthPlugin from '../../plugins/internal-auth.js';
import kvCredentialsRoutes from './kv-credentials.js';
import { KvCredentialsService } from '../../services/kv-credentials.js';
import { ApiKeyService } from '../../services/api-key-service.js';

const PLATFORM_URL =
  process.env.NEON_PLATFORM_PRIMARY_URL ??
  'postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control';

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === '1';
const describeDb = RUN_DB_TESTS ? describe : describe.skip;

let app: ReturnType<typeof Fastify>;
let pool: pg.Pool;
let svc: KvCredentialsService;
let testUserId: string;
let testAppId: string;

beforeAll(async () => {
  if (!RUN_DB_TESTS) return;

  process.env.BUTTERBASE_INTERNAL_SECRET = 'test-secret';

  pool = new pg.Pool({ connectionString: PLATFORM_URL });
  svc = new KvCredentialsService(pool);

  // Create a stable test user for FK references
  const r = await pool.query(
    `INSERT INTO platform_users (id, email, account_status, plan_id)
     VALUES ($1, 'kv-route-test@example.com', 'active', 'playground')
     ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id`,
    [randomUUID()],
  );
  testUserId = r.rows[0].id;

  app = Fastify();
  app.decorate('controlDb', pool);
  await app.register(internalAuthPlugin);
  await app.register(kvCredentialsRoutes);
  await app.ready();
});

afterAll(async () => {
  if (!RUN_DB_TESTS) return;
  await app.close();
  await pool.query(`DELETE FROM app_kv_credentials WHERE app_id LIKE 'kv-route-test-%'`);
  await pool.query(`DELETE FROM apps WHERE id LIKE 'kv-route-test-%'`);
  await pool.query(`DELETE FROM platform_users WHERE email = 'kv-route-test@example.com'`);
  await pool.end();
});

beforeEach(async () => {
  if (!RUN_DB_TESTS) return;
  await pool.query(`DELETE FROM app_kv_credentials WHERE app_id LIKE 'kv-route-test-%'`);
  await pool.query(`DELETE FROM apps WHERE id LIKE 'kv-route-test-%'`);
  const id = `kv-route-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await pool.query(
    `INSERT INTO apps (id, name, owner_id, db_name, region)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, `KV Route Test App ${id}`, testUserId, `db_${id}`, 'us'],
  );
  testAppId = id;
});

describeDb('GET /v1/internal/kv/credentials/:app_id', () => {
  it('returns 401 without the internal secret header', async () => {
    const r = await app.inject({
      method: 'GET',
      url: `/v1/internal/kv/credentials/${testAppId}`,
    });
    expect(r.statusCode).toBe(401);
  });

  it('returns 404 for an app with no credential', async () => {
    const r = await app.inject({
      method: 'GET',
      url: `/v1/internal/kv/credentials/${testAppId}`,
      headers: { 'x-butterbase-internal-secret': 'test-secret' },
    });
    expect(r.statusCode).toBe(404);
    expect(r.json().error).toBe('not_found');
  });

  it('returns 404 for an unknown app id', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/v1/internal/kv/credentials/app_does_not_exist',
      headers: { 'x-butterbase-internal-secret': 'test-secret' },
    });
    expect(r.statusCode).toBe(404);
  });

  it('returns 200 with credential shape after provisioning', async () => {
    await svc.provision(testAppId, 'us');
    const r = await app.inject({
      method: 'GET',
      url: `/v1/internal/kv/credentials/${testAppId}`,
      headers: { 'x-butterbase-internal-secret': 'test-secret' },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.app_id).toBe(testAppId);
    expect(body.region).toBe('us');
    expect(typeof body.redis_password).toBe('string');
    expect(body.redis_password.length).toBeGreaterThan(0);
  });
});

describeDb('POST /v1/internal/kv/credentials/:app_id/rotate', () => {
  it('returns 401 without the internal secret header', async () => {
    await svc.provision(testAppId, 'us');
    const r = await app.inject({
      method: 'POST',
      url: `/v1/internal/kv/credentials/${testAppId}/rotate`,
    });
    expect(r.statusCode).toBe(401);
  });

  it('returns 404 when no credential exists', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/v1/internal/kv/credentials/${testAppId}/rotate`,
      headers: { 'x-butterbase-internal-secret': 'test-secret' },
    });
    expect(r.statusCode).toBe(404);
  });

  it('rotates the password and advances rotated_at', async () => {
    const before = await svc.provision(testAppId, 'us');
    // Small delay to ensure rotated_at timestamp differs
    await new Promise((r) => setTimeout(r, 5));

    const r = await app.inject({
      method: 'POST',
      url: `/v1/internal/kv/credentials/${testAppId}/rotate`,
      headers: { 'x-butterbase-internal-secret': 'test-secret' },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.app_id).toBe(testAppId);
    expect(typeof body.redis_password).toBe('string');
    expect(body.redis_password).not.toBe(before.redis_password);
    expect(typeof body.rotated_at).toBe('string');
    expect(new Date(body.rotated_at).getTime()).toBeGreaterThan(before.rotated_at.getTime());
  });
});

describeDb('POST /v1/internal/kv/resolve-key', () => {
  it('returns app_id + region + redis_password for a valid API key', async () => {
    // Provision a KV credential for the test app
    await svc.provision(testAppId, 'us');

    // Generate an API key for the test user (plaintext returned once)
    const { key: plainKey } = await ApiKeyService.generateApiKey(
      pool,
      testUserId,
      'kv-resolve-test-key',
    );

    const r = await app.inject({
      method: 'POST',
      url: '/v1/internal/kv/resolve-key',
      headers: {
        'x-butterbase-internal-secret': 'test-secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ api_key: plainKey }),
    });

    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.app_id).toBe(testAppId);
    expect(body.region).toBe('us');
    expect(typeof body.redis_password).toBe('string');
    expect(body.redis_password.length).toBeGreaterThan(0);

    // Clean up the generated key
    await pool.query(`DELETE FROM api_keys WHERE name = 'kv-resolve-test-key' AND user_id = $1`, [
      testUserId,
    ]);
  });

  it('returns 404 for an unknown API key', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/internal/kv/resolve-key',
      headers: {
        'x-butterbase-internal-secret': 'test-secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ api_key: 'bb_live_does_not_exist' }),
    });

    expect(r.statusCode).toBe(404);
    expect(r.json().error).toBe('invalid_key');
  });
});
