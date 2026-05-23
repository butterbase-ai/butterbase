import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import internalAuthPlugin from '../../plugins/internal-auth.js';
import kvProxyRoutes from './kv-proxy.js';
import { ApiKeyService } from '../../services/api-key-service.js';

const PLATFORM_URL =
  process.env.NEON_PLATFORM_PRIMARY_URL ??
  'postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control';

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === '1';
const describeDb = RUN_DB_TESTS ? describe : describe.skip;

let app: ReturnType<typeof Fastify>;
let pool: pg.Pool;
let testUserId: string;
let testAppId: string;
let devApiKeyPlain: string;

beforeAll(async () => {
  if (!RUN_DB_TESTS) return;

  process.env.BUTTERBASE_INTERNAL_SECRET = 'test-secret';
  process.env.KV_GATEWAY_URL_US = 'https://kv-gateway-us.example.com';

  pool = new pg.Pool({ connectionString: PLATFORM_URL });

  // Create a stable test user for FK references
  const r = await pool.query(
    `INSERT INTO platform_users (id, email, account_status, plan_id)
     VALUES ($1, 'kv-proxy-test@example.com', 'active', 'playground')
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
  if (!RUN_DB_TESTS) return;
  await app.close();
  await pool.query(`DELETE FROM api_keys WHERE name LIKE 'kv-proxy-test-%'`);
  await pool.query(`DELETE FROM apps WHERE id LIKE 'kv-proxy-test-%'`);
  await pool.query(`DELETE FROM platform_users WHERE email = 'kv-proxy-test@example.com'`);
  await pool.end();
  delete process.env.KV_GATEWAY_URL_US;
});

beforeEach(async () => {
  if (!RUN_DB_TESTS) return;
  await pool.query(`DELETE FROM api_keys WHERE name LIKE 'kv-proxy-test-%'`);
  await pool.query(`DELETE FROM apps WHERE id LIKE 'kv-proxy-test-%'`);

  const id = `kv-proxy-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await pool.query(
    `INSERT INTO apps (id, name, owner_id, db_name, region)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, `KV Proxy Test App ${id}`, testUserId, `db_${id}`, 'us'],
  );
  testAppId = id;

  const { key } = await ApiKeyService.generateApiKey(pool, testUserId, 'kv-proxy-test-key');
  devApiKeyPlain = key;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describeDb('ALL /v1/internal/kv/proxy/:app_id/*', () => {
  it('forwards GET to the regional gateway and returns the body verbatim', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ value: 'hello', ttl: 60 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const res = await app.inject({
      method: 'GET',
      url: `/v1/internal/kv/proxy/${testAppId}/sessions/abc`,
      headers: { authorization: `Bearer ${devApiKeyPlain}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ value: 'hello', ttl: 60 });
    expect(fetchSpy).toHaveBeenCalledOnce();

    const [calledUrl, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(String(calledUrl)).toMatch(/\/v1\/kv-proxy-test-[^/]+\/kv\/sessions\/abc$/);
    expect(String(calledUrl)).toContain('kv-gateway-us.example.com');
    expect((init as RequestInit).method).toBe('GET');
    const sentHeaders = init.headers as Headers;
    expect(sentHeaders.get('authorization')).toBe(`Bearer ${devApiKeyPlain}`);
  });

  it('returns 401 when no bearer token is supplied', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/internal/kv/proxy/${testAppId}/foo`,
      // no authorization header
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('missing_bearer');
  });

  it('returns 403 when the api key does not own the requested app', async () => {
    // Create a second user + app that testUser's key cannot access
    const r2 = await pool.query(
      `INSERT INTO platform_users (id, email, account_status, plan_id)
       VALUES ($1, 'kv-proxy-other@example.com', 'active', 'playground')
       ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id`,
      [randomUUID()],
    );
    const otherUserId = r2.rows[0].id;
    const otherId = `kv-proxy-test-other-${Date.now()}`;
    await pool.query(
      `INSERT INTO apps (id, name, owner_id, db_name, region) VALUES ($1, $2, $3, $4, $5)`,
      [otherId, `KV Proxy Other App`, otherUserId, `db_${otherId}`, 'us'],
    );

    try {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/internal/kv/proxy/${otherId}/foo`,
        headers: { authorization: `Bearer ${devApiKeyPlain}` },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('forbidden');
    } finally {
      await pool.query(`DELETE FROM apps WHERE id = $1`, [otherId]);
      await pool.query(`DELETE FROM platform_users WHERE id = $1`, [otherUserId]);
    }
  });

  it('PUT forwards body to upstream', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const requestBody = { key: 'mykey', value: 'myvalue', ttl: 120 };

    const res = await app.inject({
      method: 'PUT',
      url: `/v1/internal/kv/proxy/${testAppId}/mykey`,
      headers: { authorization: `Bearer ${devApiKeyPlain}`, 'content-type': 'application/json' },
      payload: JSON.stringify(requestBody),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(fetchSpy).toHaveBeenCalledOnce();

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect((init as RequestInit).method).toBe('PUT');
    expect(init.body).toBeDefined();
    const sentBody = JSON.parse(String(init.body));
    expect(sentBody).toEqual(requestBody);
  });

  it('returns non-2xx status and body from upstream verbatim', async () => {
    const upstreamError = { error: 'missing' };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(upstreamError), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const res = await app.inject({
      method: 'GET',
      url: `/v1/internal/kv/proxy/${testAppId}/nonexistent`,
      headers: { authorization: `Bearer ${devApiKeyPlain}` },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual(upstreamError);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });
});
