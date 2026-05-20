import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import pg from 'pg';
import { databasePlugin } from '../plugins/database.js';
import { dataPlanePlugin } from '../plugins/data-plane.js';
import { initRoutes } from '../routes/init.js';
import { rlsRoutes } from '../routes/rls.js';
import { config } from '../config.js';

const app = Fastify();
let appId: string;
let appPool: pg.Pool;

beforeAll(async () => {
  // Inject a test auth context so requireUserId() succeeds without a real JWT
  app.decorateRequest('auth', null as any);
  app.addHook('onRequest', async (request) => {
    (request as any).auth = {
      userId: config.devOwnerId,
      authMethod: 'api_key',
      scopes: ['*'],
    };
  });

  app.register(databasePlugin);
  app.register(dataPlanePlugin);
  app.register(initRoutes);
  app.register(rlsRoutes);
  await app.ready();

  // Provision a test app
  const res = await app.inject({
    method: 'POST',
    url: '/init',
    payload: { name: `rls-routes-test-${Date.now()}` },
  });
  expect(res.statusCode).toBe(201);
  appId = res.json().app_id;

  // Wait for background provisioning to complete
  for (let i = 0; i < 30; i++) {
    const status = await app.inject({ method: 'GET', url: `/apps/${appId}/status` });
    const { provisioning_status } = status.json();
    if (provisioning_status === 'ready') break;
    if (provisioning_status === 'failed') throw new Error('Test app provisioning failed');
    await new Promise((r) => setTimeout(r, 200));
  }

  // Connect directly to the app's database to set up RLS test fixtures.
  // In local dev the app database name equals the app_id.
  appPool = new pg.Pool({
    host: config.dataPlaneDb.host,
    port: config.dataPlaneDb.port,
    user: config.dataPlaneDb.user,
    password: config.dataPlaneDb.password,
    database: appId,
  });

  // Create two tables: one with RLS-on + a policy, one with RLS-on + zero policies
  await appPool.query(`CREATE TABLE IF NOT EXISTS rls_with_policy (id uuid PRIMARY KEY, user_id uuid)`);
  await appPool.query(`CREATE TABLE IF NOT EXISTS rls_no_policies (id uuid PRIMARY KEY)`);
  await appPool.query(`ALTER TABLE rls_with_policy ENABLE ROW LEVEL SECURITY`);
  await appPool.query(`ALTER TABLE rls_no_policies ENABLE ROW LEVEL SECURITY`);
  await appPool.query(
    `CREATE POLICY p1 ON rls_with_policy FOR ALL TO butterbase_user USING (user_id = current_user_id()::uuid)`
  );

  // Set up fixture for PATCH tests
  await appPool.query(`CREATE TABLE IF NOT EXISTS patch_test (id uuid PRIMARY KEY, user_id uuid, owner_id uuid)`);
  await appPool.query(`ALTER TABLE patch_test ENABLE ROW LEVEL SECURITY`);
  await appPool.query(
    `CREATE POLICY patch_replace ON patch_test FOR ALL TO butterbase_user USING (user_id = current_user_id()::uuid)`
  );
  await appPool.query(
    `CREATE POLICY patch_rollback ON patch_test FOR ALL TO butterbase_user USING (user_id = current_user_id()::uuid)`
  );
  // Note: 'missing_policy' is not created — that's the 404 test target
}, 30000);

afterAll(async () => {
  if (appPool) await appPool.end();
  await app.close();
});

describe('GET /v1/:app_id/rls', () => {
  it('returns policies AND tables_with_rls', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/${appId}/rls`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.policies).toBeInstanceOf(Array);
    expect(body.tables_with_rls).toBeInstanceOf(Array);
    expect(body.tables_with_rls).toContain('rls_no_policies');
    expect(body.tables_with_rls).toContain('rls_with_policy');
  });

  it('omits tables that do not have RLS enabled', async () => {
    await appPool.query(`CREATE TABLE IF NOT EXISTS no_rls (id uuid PRIMARY KEY)`);
    const res = await app.inject({
      method: 'GET',
      url: `/v1/${appId}/rls`,
    });
    const body = res.json();
    expect(body.tables_with_rls).not.toContain('no_rls');
  });
});

describe('PATCH /v1/:app_id/rls/policies/:policy_name', () => {
  it('atomically replaces a policy with a new expression', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/${appId}/rls/policies/patch_replace`,
      payload: {
        table_name: 'patch_test',
        command: 'ALL',
        role: 'user',
        using_expression: 'owner_id = current_user_id()::uuid',
      },
    });
    expect(res.statusCode).toBe(200);

    const policy = await appPool.query(
      `SELECT qual FROM pg_policies WHERE policyname = 'patch_replace' AND tablename = 'patch_test'`
    );
    expect(policy.rows[0].qual).toContain('owner_id');
  });

  it('rolls back atomically when the new policy SQL is invalid', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/${appId}/rls/policies/patch_rollback`,
      payload: {
        table_name: 'patch_test',
        command: 'ALL',
        role: 'user',
        using_expression: 'this is not valid sql !!!',
      },
    });
    expect(res.statusCode).toBe(400);

    // Original (or last successfully applied) policy must still exist
    const policy = await appPool.query(
      `SELECT 1 FROM pg_policies WHERE policyname = 'patch_rollback' AND tablename = 'patch_test'`
    );
    expect(policy.rowCount).toBe(1);
  });

  it('returns 404 when the policy does not exist', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/${appId}/rls/policies/missing_policy`,
      payload: {
        table_name: 'patch_test',
        command: 'ALL',
        using_expression: 'true',
      },
    });
    expect(res.statusCode).toBe(404);
  });
});
