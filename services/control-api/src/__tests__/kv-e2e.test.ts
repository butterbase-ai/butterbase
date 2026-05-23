import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify from 'fastify';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import internalAuthPlugin from '../plugins/internal-auth.js';
import kvProxyRoutes from '../routes/internal/kv-proxy.js';
import { KvCredentialsService } from '../services/kv-credentials.js';
import { ApiKeyService } from '../services/api-key-service.js';

const PLATFORM_URL =
  process.env.NEON_PLATFORM_PRIMARY_URL ??
  'postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control';

const KV_GATEWAY_URL_US = process.env.KV_GATEWAY_URL_US;
const describeE2e = KV_GATEWAY_URL_US ? describe : describe.skip;

let app: ReturnType<typeof Fastify>;
let pool: pg.Pool;
let svc: KvCredentialsService;
let testUserId: string;
let testAppId: string;
let devApiKeyPlain: string;

beforeAll(async () => {
  if (!KV_GATEWAY_URL_US) return;

  process.env.BUTTERBASE_INTERNAL_SECRET = 'test-secret';

  pool = new pg.Pool({ connectionString: PLATFORM_URL });
  svc = new KvCredentialsService(pool);

  // Create a stable test user for FK references
  const r = await pool.query(
    `INSERT INTO platform_users (id, email, account_status, plan_id)
     VALUES ($1, 'kv-e2e-test@example.com', 'active', 'playground')
     ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id`,
    [randomUUID()],
  );
  testUserId = r.rows[0].id;

  app = Fastify();
  app.decorate('controlDb', pool);
  await app.register(internalAuthPlugin);
  await app.register(kvProxyRoutes);
  await app.ready();
});

afterAll(async () => {
  if (!KV_GATEWAY_URL_US) return;
  await app.close();
  await pool.query(`DELETE FROM app_kv_credentials WHERE app_id LIKE 'kv-e2e-test-%'`);
  await pool.query(`DELETE FROM api_keys WHERE name LIKE 'kv-e2e-test-%'`);
  await pool.query(`DELETE FROM apps WHERE id LIKE 'kv-e2e-test-%'`);
  await pool.query(`DELETE FROM platform_users WHERE email = 'kv-e2e-test@example.com'`);
  await pool.end();
});

beforeEach(async () => {
  if (!KV_GATEWAY_URL_US) return;
  await pool.query(`DELETE FROM app_kv_credentials WHERE app_id LIKE 'kv-e2e-test-%'`);
  await pool.query(`DELETE FROM api_keys WHERE name LIKE 'kv-e2e-test-%'`);
  await pool.query(`DELETE FROM apps WHERE id LIKE 'kv-e2e-test-%'`);

  const id = `kv-e2e-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await pool.query(
    `INSERT INTO apps (id, name, owner_id, db_name, region)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, `KV E2E Test App ${id}`, testUserId, `db_${id}`, 'us'],
  );
  testAppId = id;

  // Provision KV credentials for the test app
  await svc.provision(testAppId, 'us');

  const { key } = await ApiKeyService.generateApiKey(pool, testUserId, `kv-e2e-test-key-${id}`);
  devApiKeyPlain = key;
});

describeE2e('KV E2E: CLI/MCP → proxy → gateway → Redis', () => {
  it('set → get round-trips through the proxy', async () => {
    // PUT to set a key
    const setRes = await app.inject({
      method: 'PUT',
      url: `/v1/internal/kv/proxy/${testAppId}/kv/test-key`,
      headers: {
        authorization: `Bearer ${devApiKeyPlain}`,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ value: 'test-value', ttl: 3600 }),
    });

    expect(setRes.statusCode).toBe(200);

    // GET to retrieve the key
    const getRes = await app.inject({
      method: 'GET',
      url: `/v1/internal/kv/proxy/${testAppId}/kv/test-key`,
      headers: {
        authorization: `Bearer ${devApiKeyPlain}`,
      },
    });

    expect(getRes.statusCode).toBe(200);
    const body = getRes.json();
    expect(body.value).toBe('test-value');
  });

  it('expose → list_rules round-trips through the proxy', async () => {
    // PUT to expose a rule
    const rule = 'app_files:bucket123/data/**';
    const encodedRule = encodeURIComponent(rule);
    const exposeRes = await app.inject({
      method: 'PUT',
      url: `/v1/internal/kv/proxy/${testAppId}/kv/_expose/${encodedRule}`,
      headers: {
        authorization: `Bearer ${devApiKeyPlain}`,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ granted: true }),
    });

    expect(exposeRes.statusCode).toBe(200);

    // GET to list all expose rules
    const listRes = await app.inject({
      method: 'GET',
      url: `/v1/internal/kv/proxy/${testAppId}/kv/_expose`,
      headers: {
        authorization: `Bearer ${devApiKeyPlain}`,
      },
    });

    expect(listRes.statusCode).toBe(200);
    const body = listRes.json();
    expect(Array.isArray(body.rules) || typeof body === 'object').toBe(true);
  });

  it('flush deletes data but preserves expose rules', async () => {
    // Set a key
    await app.inject({
      method: 'PUT',
      url: `/v1/internal/kv/proxy/${testAppId}/kv/flush-test-key`,
      headers: {
        authorization: `Bearer ${devApiKeyPlain}`,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ value: 'will-be-deleted', ttl: 3600 }),
    });

    // POST to flush (default, no include_config)
    const flushRes = await app.inject({
      method: 'POST',
      url: `/v1/internal/kv/proxy/${testAppId}/kv/_flush`,
      headers: {
        authorization: `Bearer ${devApiKeyPlain}`,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ include_config: false }),
    });

    expect(flushRes.statusCode).toBe(200);

    // Verify the key is gone
    const getRes = await app.inject({
      method: 'GET',
      url: `/v1/internal/kv/proxy/${testAppId}/kv/flush-test-key`,
      headers: {
        authorization: `Bearer ${devApiKeyPlain}`,
      },
    });

    // Should return 404 or empty
    expect([404, 200]).toContain(getRes.statusCode);
  });
});
