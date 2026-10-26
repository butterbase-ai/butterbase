import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { databasePlugin } from '../plugins/database.js';
import { dataPlanePlugin } from '../plugins/data-plane.js';
import runtimeDatabasePlugin from '../plugins/runtime-database.js';
import authPlugin from '../plugins/auth.js';
import { KvCredentialsService } from '../services/kv-credentials.js';

// Ensure platform auth is enabled so JWT verification (and 401 fallback) runs.
process.env.AUTH_ENABLED = 'true';
process.env.BUTTERBASE_REGIONS = process.env.BUTTERBASE_REGIONS ?? 'us-east-1';
process.env.BUTTERBASE_REGION = process.env.BUTTERBASE_REGION ?? 'us-east-1';
process.env.NEON_DATA_PROJECT_ID_US_EAST_1 =
  process.env.NEON_DATA_PROJECT_ID_US_EAST_1 ?? 'local-dev-data-project';
process.env.NEON_RUNTIME_PROJECT_ID_US_EAST_1 =
  process.env.NEON_RUNTIME_PROJECT_ID_US_EAST_1 ??
  'postgresql://butterbase:butterbase_dev@localhost:5437/butterbase_runtime_us';

let app: FastifyInstance;
let appId: string;
let otherAppId: string;
let fsk: string;

// Fresh fixture identities avoid collisions with other authentication tests.
const testUserId = randomUUID();
const testOrgId = randomUUID();

async function provisionApp(): Promise<string> {
  const id = `app_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  await app.runtimeDb('us-east-1').query(
    "INSERT INTO apps (id,name,owner_id,organization_id,db_name,region) VALUES ($1,$1,$2,$3,$1,'us-east-1')",
    [id, testUserId, testOrgId],
  );
  await app.controlDb.query("INSERT INTO org_app_index (app_id,organization_id,region) VALUES ($1,$2,'us-east-1')", [id, testOrgId]);
  return id;
}

beforeAll(async () => {
  app = Fastify();
  await app.register(databasePlugin);
  await app.register(dataPlanePlugin);
  await app.register(runtimeDatabasePlugin);
  await app.register(authPlugin);

  // Trivial probe route that echoes the auth context produced by authPlugin.
  app.get<{ Params: { appId: string } }>(
    '/v1/:appId/__probe',
    async (request) => ({
      authMethod: request.auth.authMethod,
      userId: request.auth.userId,
      appId: (request.auth as any).appId ?? null,
      scopes: request.auth.scopes,
      organizationLocked: request.auth.organizationLocked ?? false,
    }),
  );

  await app.ready();

  // Current schema requires a personal organization for every platform user.
  await app.controlDb.query("INSERT INTO organizations (id,owner_id,name,personal,plan_id) VALUES ($1,$2,'Function key test',true,'playground')", [testOrgId, testUserId]);
  await app.controlDb.query(
    `INSERT INTO platform_users (id, cognito_sub, email, personal_organization_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO NOTHING`,
    [testUserId, `test-${testUserId}`, `${testUserId}@test.local`, testOrgId],
  );

  appId = await provisionApp();
  // For the cross-app rejection case we don't need a fully provisioned second
  // app — we just need a URL-shaped app_id that won't match in app_kv_credentials.
  // Using a real-but-different ID avoids tripping the per-user project quota.
  otherAppId = `app_${'z'.repeat(12)}`;

  // Seed only the function credential; no external app provisioning is needed.
  const svc = new KvCredentialsService(app.controlDb);
  const cred = await svc.provision(appId, 'us-east-1');
  fsk = cred.kv_function_key;
});

afterAll(async () => {
  if (app) {
    if (appId) await app.runtimeDb('us-east-1').query('DELETE FROM apps WHERE id=$1', [appId]);
    await app.controlDb.query('DELETE FROM org_app_index WHERE app_id=$1', [appId]);
    await app.controlDb.query('DELETE FROM platform_users WHERE id=$1', [testUserId]);
    await app.controlDb.query('DELETE FROM organizations WHERE id=$1', [testOrgId]);
    await app.close();
  }
});

describe('function-key auth recognition', () => {
  it('accepts FSK when the appId in the URL matches', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/${appId}/__probe`,
      headers: { authorization: `Bearer ${fsk}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.authMethod).toBe('function_key');
    expect(body.organizationLocked).toBe(false);
    expect(body.appId).toBe(appId);
    expect(body.scopes).toContain('integrations:execute');
    expect(body.userId).not.toBeNull();
  });

  it('rejects FSK when the URL targets a different app', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/${otherAppId}/__probe`,
      headers: { authorization: `Bearer ${fsk}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('AUTH_INVALID_TOKEN');
  });

  it('rejects FSK when the URL has no appId segment', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api-keys`,
      headers: { authorization: `Bearer ${fsk}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a junk hex token of FSK-like shape', async () => {
    const junk = 'a'.repeat(40);
    const res = await app.inject({
      method: 'GET',
      url: `/v1/${appId}/__probe`,
      headers: { authorization: `Bearer ${junk}` },
    });
    expect(res.statusCode).toBe(401);
  });
});
