import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { databasePlugin } from '../plugins/database.js';
import { dataPlanePlugin } from '../plugins/data-plane.js';
import runtimeDatabasePlugin from '../plugins/runtime-database.js';
import authPlugin from '../plugins/auth.js';
import { initRoutes } from '../routes/init.js';
import { KvCredentialsService } from '../services/kv-credentials.js';

// Ensure platform auth is enabled so JWT verification (and 401 fallback) runs.
// The E2E bypass header is used only to provision test apps via POST /init.
process.env.AUTH_ENABLED = 'true';
process.env.BUTTERBASE_E2E = '1';
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

// Fresh per-test platform-user UUID. /init's plan-limit check skips when
// the user has no row in platform_users, so a never-seen UUID bypasses quotas.
const testUserId = randomUUID();

async function provisionApp(): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/init',
    headers: { 'x-test-user-id': testUserId },
    payload: { name: `fk-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
  });
  if (res.statusCode !== 200 && res.statusCode !== 201) {
    throw new Error(`/init failed: ${res.statusCode} ${res.body}`);
  }
  return res.json().app_id;
}

beforeAll(async () => {
  app = Fastify();
  await app.register(databasePlugin);
  await app.register(dataPlanePlugin);
  await app.register(runtimeDatabasePlugin);
  await app.register(authPlugin);
  await app.register(initRoutes);

  // Trivial probe route that echoes the auth context produced by authPlugin.
  app.get<{ Params: { appId: string } }>(
    '/v1/:appId/__probe',
    async (request) => ({
      authMethod: request.auth.authMethod,
      userId: request.auth.userId,
      appId: (request.auth as any).appId ?? null,
      scopes: request.auth.scopes,
    }),
  );

  await app.ready();

  // Seed the test user in platform_users so /init's owner check passes.
  // We omit plan_id so the per-plan project quota check skips this user.
  await app.controlDb.query(
    `INSERT INTO platform_users (id, cognito_sub, email)
     VALUES ($1, $2, $3)
     ON CONFLICT (id) DO NOTHING`,
    [testUserId, `test-${testUserId}`, `${testUserId}@test.local`],
  );

  appId = await provisionApp();
  // For the cross-app rejection case we don't need a fully provisioned second
  // app — we just need a URL-shaped app_id that won't match in app_kv_credentials.
  // Using a real-but-different ID avoids tripping the per-user project quota.
  otherAppId = `app_${'z'.repeat(12)}`;

  // KvCredentialsService.provision is idempotent (ON CONFLICT DO NOTHING +
  // SELECT). /init already provisioned a credential during app creation, so
  // calling provision() again returns the existing row unchanged.
  const svc = new KvCredentialsService(app.controlDb);
  const cred = await svc.provision(appId, 'us-east-1');
  fsk = cred.kv_function_key;
});

afterAll(async () => {
  if (app) await app.close();
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
