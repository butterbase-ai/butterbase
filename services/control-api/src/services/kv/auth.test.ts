import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { KvCredentialsService } from '../kv-credentials.js';
import { ApiKeyService } from '../api-key-service.js';
import { resolveKvAuth } from './auth.js';

const PLATFORM_URL =
  process.env.NEON_PLATFORM_PRIMARY_URL ??
  'postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control';

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === '1';
const describeDb = RUN_DB_TESTS ? describe : describe.skip;

let pool: pg.Pool;
let svc: KvCredentialsService;
let testUserId: string;
let testAppId: string;

// Build a minimal FastifyRequest stub with .headers
function reqWith(authz?: string): any {
  return { headers: authz ? { authorization: authz } : {} };
}

beforeAll(async () => {
  if (!RUN_DB_TESTS) return;

  pool = new pg.Pool({ connectionString: PLATFORM_URL });
  svc = new KvCredentialsService(pool);

  // Create a stable test user for FK references
  const r = await pool.query(
    `INSERT INTO platform_users (id, email, account_status, plan_id)
     VALUES ($1, 'kv-auth-svc-test@example.com', 'active', 'playground')
     ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id`,
    [randomUUID()],
  );
  testUserId = r.rows[0].id;
});

afterAll(async () => {
  if (!RUN_DB_TESTS) return;
  await pool.query(`DELETE FROM app_kv_credentials WHERE app_id LIKE 'kv-auth-svc-%'`);
  await pool.query(`DELETE FROM apps WHERE id LIKE 'kv-auth-svc-%'`);
  await pool.query(
    `DELETE FROM platform_users WHERE email = 'kv-auth-svc-test@example.com'`,
  );
  await pool.end();
});

beforeEach(async () => {
  if (!RUN_DB_TESTS) return;
  await pool.query(`DELETE FROM app_kv_credentials WHERE app_id LIKE 'kv-auth-svc-%'`);
  await pool.query(`DELETE FROM apps WHERE id LIKE 'kv-auth-svc-%'`);

  const id = `kv-auth-svc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await pool.query(
    `INSERT INTO apps (id, name, owner_id, db_name, region)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, `KV Auth Svc Test App ${id}`, testUserId, `db_${id}`, 'us'],
  );
  testAppId = id;
});

describeDb('resolveKvAuth', () => {
  it('no auth header → anon identity with anon redis creds', async () => {
    await svc.provision(testAppId, 'us');

    const result = await resolveKvAuth(pool, testAppId, reqWith());

    expect('error' in result).toBe(false);
    if ('error' in result) return; // type narrowing

    expect(result.identity.kind).toBe('anon');
    expect(result.allowExposeWrites).toBe(false);
    expect(result.appId).toBe(testAppId);
    expect(result.region).toBe('us');
    expect(typeof result.redisPassword).toBe('string');
    expect(result.redisPassword.length).toBeGreaterThan(0);
  });

  // TODO: JWT path requires runtime-plane DB + jose signing fixture (app_signing_keys row
  // in the app's home region). Covered end-to-end by Task 4's route tests.
  it.skip('valid JWT → jwt identity with userId/role and allowExposeWrites=false', async () => {
    // Would need: provision KV creds, insert app_signing_keys in runtime DB,
    // sign a token with jose using the private key, then call resolveKvAuth.
  });

  it('valid dev API key (Bearer <plaintext>) → apiKey identity, allowExposeWrites=true', async () => {
    await svc.provision(testAppId, 'us');

    const { key: plainKey } = await ApiKeyService.generateApiKey(
      pool,
      testUserId,
      'kv-auth-svc-dev-key',
    );

    try {
      const result = await resolveKvAuth(pool, testAppId, reqWith(`Bearer ${plainKey}`));

      expect('error' in result).toBe(false);
      if ('error' in result) return;

      expect(result.identity.kind).toBe('apiKey');
      expect(result.allowExposeWrites).toBe(true);
      expect(result.appId).toBe(testAppId);
      expect(result.region).toBe('us');
      expect(typeof result.redisPassword).toBe('string');
    } finally {
      await pool.query(
        `DELETE FROM api_keys WHERE name = 'kv-auth-svc-dev-key' AND user_id = $1`,
        [testUserId],
      );
    }
  });

  it('valid function key (Bearer <plaintext fn key>) → function identity, allowExposeWrites=true', async () => {
    const cred = await svc.provision(testAppId, 'us');

    const result = await resolveKvAuth(
      pool,
      testAppId,
      reqWith(`Bearer ${cred.kv_function_key}`),
    );

    expect('error' in result).toBe(false);
    if ('error' in result) return;

    expect(result.identity.kind).toBe('function');
    expect(result.allowExposeWrites).toBe(true);
    expect(result.appId).toBe(testAppId);
    expect(result.region).toBe('us');
    expect(typeof result.redisPassword).toBe('string');
  });

  it('unknown bearer (neither JWT nor key) → 403 forbidden', async () => {
    await svc.provision(testAppId, 'us');

    const result = await resolveKvAuth(
      pool,
      testAppId,
      reqWith('Bearer totallyunknowntoken12345'),
    );

    expect('error' in result).toBe(true);
    if (!('error' in result)) return;

    expect(result.error).toBe('auth_failed');
    expect(result.status).toBe(403);
    expect(result.body.error).toBe('forbidden');
  });
});
