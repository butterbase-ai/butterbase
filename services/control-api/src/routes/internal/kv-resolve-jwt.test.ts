import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import internalAuthPlugin from '../../plugins/internal-auth.js';
import kvResolveJwtRoutes from './kv-resolve-jwt.js';
import { KvCredentialsService } from '../../services/kv-credentials.js';
import * as endUserAuth from '../../services/end-user-auth.js';

vi.mock('../../services/end-user-auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/end-user-auth.js')>();
  return { ...actual, verifyEndUserJwt: vi.fn() };
});

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
const SECRET = 'test-secret';
const H = { 'x-butterbase-internal-secret': SECRET };

beforeAll(async () => {
  if (!RUN_DB_TESTS) return;
  process.env.BUTTERBASE_INTERNAL_SECRET = SECRET;
  pool = new pg.Pool({ connectionString: PLATFORM_URL });
  svc = new KvCredentialsService(pool);

  const r = await pool.query(
    `INSERT INTO platform_users (id, email, account_status, plan_id)
     VALUES ($1, 'kv-resolve-jwt-test@example.com', 'active', 'playground')
     ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id`,
    [randomUUID()],
  );
  testUserId = r.rows[0].id;

  app = Fastify();
  app.decorate('controlDb', pool);
  await app.register(internalAuthPlugin);
  await app.register(kvResolveJwtRoutes);
  await app.ready();
});

afterAll(async () => {
  if (!RUN_DB_TESTS) return;
  await app.close();
  await pool.query(`DELETE FROM app_kv_credentials WHERE app_id LIKE 'kv-resolve-jwt-test-%'`);
  await pool.query(`DELETE FROM apps WHERE id LIKE 'kv-resolve-jwt-test-%'`);
  await pool.query(`DELETE FROM platform_users WHERE email = 'kv-resolve-jwt-test@example.com'`);
  await pool.end();
});

beforeEach(async () => {
  if (!RUN_DB_TESTS) return;
  vi.mocked(endUserAuth.verifyEndUserJwt).mockReset();
  await pool.query(`DELETE FROM app_kv_credentials WHERE app_id LIKE 'kv-resolve-jwt-test-%'`);
  await pool.query(`DELETE FROM apps WHERE id LIKE 'kv-resolve-jwt-test-%'`);
  const id = `kv-resolve-jwt-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await pool.query(
    `INSERT INTO apps (id, name, owner_id, db_name, region)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, `Resolve JWT Test App ${id}`, testUserId, `db_${id}`, 'us'],
  );
  testAppId = id;
});

describeDb('POST /v1/internal/kv/resolve-jwt', () => {
  it('401 without internal secret header', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/internal/kv/resolve-jwt',
      payload: { jwt: 'x', app_id: testAppId },
    });
    expect(r.statusCode).toBe(401);
  });

  it('400 when fields missing', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/internal/kv/resolve-jwt',
      headers: H,
      payload: {},
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('missing_fields');
  });

  it('401 invalid_jwt when verifyEndUserJwt throws', async () => {
    vi.mocked(endUserAuth.verifyEndUserJwt).mockRejectedValueOnce(new Error('bad sig'));
    const r = await app.inject({
      method: 'POST',
      url: '/v1/internal/kv/resolve-jwt',
      headers: H,
      payload: { jwt: 'xxx.yyy.zzz', app_id: testAppId },
    });
    expect(r.statusCode).toBe(401);
    expect(r.json().error).toBe('invalid_jwt');
  });

  it('404 no_kv_credential when app has no credential row', async () => {
    vi.mocked(endUserAuth.verifyEndUserJwt).mockResolvedValueOnce({
      sub: 'u1',
      email: 'u1@x',
      email_verified: true,
      app_id: testAppId,
      iat: 0,
      exp: 0,
      iss: 'butterbase:app:' + testAppId,
    });
    const r = await app.inject({
      method: 'POST',
      url: '/v1/internal/kv/resolve-jwt',
      headers: H,
      payload: { jwt: 'xxx.yyy.zzz', app_id: testAppId },
    });
    expect(r.statusCode).toBe(404);
    expect(r.json().error).toBe('no_kv_credential');
  });

  it('200 with full shape on valid JWT + provisioned creds', async () => {
    await svc.provision(testAppId, 'us');
    vi.mocked(endUserAuth.verifyEndUserJwt).mockResolvedValueOnce({
      sub: 'u-abc',
      email: 'a@b',
      email_verified: true,
      app_id: testAppId,
      iat: 0,
      exp: 0,
      iss: 'butterbase:app:' + testAppId,
      // custom role claim (not in EndUserClaims type but apps may include it)
      role: 'member',
    } as any);
    const r = await app.inject({
      method: 'POST',
      url: '/v1/internal/kv/resolve-jwt',
      headers: H,
      payload: { jwt: 'xxx.yyy.zzz', app_id: testAppId },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.app_id).toBe(testAppId);
    expect(body.region).toBe('us');
    expect(typeof body.redis_password).toBe('string');
    expect(body.user_id).toBe('u-abc');
    expect(body.role).toBe('member');
  });

  it('200 with role=null when claim has no role', async () => {
    await svc.provision(testAppId, 'us');
    vi.mocked(endUserAuth.verifyEndUserJwt).mockResolvedValueOnce({
      sub: 'u-noRole',
      email: 'a@b',
      email_verified: true,
      app_id: testAppId,
      iat: 0,
      exp: 0,
      iss: 'butterbase:app:' + testAppId,
    });
    const r = await app.inject({
      method: 'POST',
      url: '/v1/internal/kv/resolve-jwt',
      headers: H,
      payload: { jwt: 'xxx.yyy.zzz', app_id: testAppId },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().role).toBeNull();
  });
});
