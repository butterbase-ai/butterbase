import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { databasePlugin } from '../plugins/database.js';
import { dataPlanePlugin } from '../plugins/data-plane.js';
import runtimeDatabasePlugin from '../plugins/runtime-database.js';
import authPlugin from '../plugins/auth.js';
import { initRoutes } from '../routes/init.js';
import { integrationRoutes } from '../routes/integrations.js';
import { config } from '../config.js';
import { KvCredentialsService } from '../services/kv-credentials.js';

const app = Fastify();
let appId: string;

beforeAll(async () => {
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
  app.register(integrationRoutes);
  await app.ready();

  const res = await app.inject({
    method: 'POST',
    url: '/init',
    payload: { name: `integrations-test-${Date.now()}` },
  });
  appId = res.json().app_id;

  for (let i = 0; i < 30; i++) {
    const status = await app.inject({ method: 'GET', url: `/apps/${appId}/status` });
    const { provisioning_status } = status.json();
    if (provisioning_status === 'ready') break;
    if (provisioning_status === 'failed') throw new Error('Test app provisioning failed');
    await new Promise((r) => setTimeout(r, 200));
  }
});

afterAll(async () => {
  await app.close();
});

describe('GET /v1/:appId/integrations/available', () => {
  it('returns curated integrations list', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/${appId}/integrations/available`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.integrations).toBeDefined();
    expect(body.integrations.length).toBeGreaterThan(0);
    expect(body.integrations[0]).toHaveProperty('toolkit');
    expect(body.integrations[0]).toHaveProperty('curated');
    // Verify all curated integrations are present
    const toolkits = body.integrations.map((i: any) => i.toolkit);
    expect(toolkits).toContain('gmail');
    expect(toolkits).toContain('slack');
    expect(toolkits).toContain('google-calendar');
  });
});

describe('GET /v1/:appId/integrations/config', () => {
  it('returns empty integrations for a new app', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/${appId}/integrations/config`,
    });
    // 200 if migration has run, 500 if tables don't exist yet
    if (res.statusCode === 200) {
      const body = res.json();
      expect(body.integrations).toEqual([]);
    } else {
      // Table may not exist in test env without migration
      expect(res.statusCode).toBe(500);
    }
  });
});

describe('POST /v1/:appId/integrations/configure', () => {
  it('rejects missing toolkit field', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/${appId}/integrations/configure`,
      payload: {},
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('rejects empty toolkit string', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/${appId}/integrations/configure`,
      payload: { toolkit: '' },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});

describe('POST /v1/:appId/integrations/execute', () => {
  it('rejects missing toolName', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/${appId}/integrations/execute`,
      payload: { params: {} },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});

describe('GET /v1/:appId/integrations/connections', () => {
  it('returns empty connections for a new app', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/${appId}/integrations/connections`,
    });
    if (res.statusCode === 200) {
      const body = res.json();
      expect(body.connections).toEqual([]);
    } else {
      // Table may not exist in test env without migration
      expect(res.statusCode).toBe(500);
    }
  });
});

describe('POST /v1/:appId/integrations/execute (function_key auth)', () => {
  let fkApp: FastifyInstance;
  let fkAppId: string;
  let fkOtherAppId: string;
  let fsk: string;
  // Use a stable end-user UUID for body.userId. The Composio backend will
  // reject it with INTEGRATIONS_* — that's fine; we only need to confirm
  // we reached the executor, not that Composio is happy.
  const someAppUserId = '00000000-0000-0000-0000-000000000001';
  const testUserId = randomUUID();

  beforeAll(async () => {
    // Enable real auth for this describe block.
    process.env.AUTH_ENABLED = 'true';
    process.env.BUTTERBASE_E2E = '1';
    process.env.BUTTERBASE_REGIONS = process.env.BUTTERBASE_REGIONS ?? 'us-east-1';
    process.env.BUTTERBASE_REGION = process.env.BUTTERBASE_REGION ?? 'us-east-1';
    process.env.NEON_DATA_PROJECT_ID_US_EAST_1 =
      process.env.NEON_DATA_PROJECT_ID_US_EAST_1 ?? 'local-dev-data-project';
    process.env.NEON_RUNTIME_PROJECT_ID_US_EAST_1 =
      process.env.NEON_RUNTIME_PROJECT_ID_US_EAST_1 ??
      'postgresql://butterbase:butterbase_dev@localhost:5437/butterbase_runtime_us';

    fkApp = Fastify();
    await fkApp.register(databasePlugin);
    await fkApp.register(dataPlanePlugin);
    await fkApp.register(runtimeDatabasePlugin);
    await fkApp.register(authPlugin);
    await fkApp.register(initRoutes);
    await fkApp.register(integrationRoutes);
    await fkApp.ready();

    // Seed the test user so /init's owner check passes.
    await fkApp.controlDb.query(
      `INSERT INTO platform_users (id, cognito_sub, email)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO NOTHING`,
      [testUserId, `test-${testUserId}`, `${testUserId}@test.local`],
    );

    const initRes = await fkApp.inject({
      method: 'POST',
      url: '/init',
      headers: { 'x-test-user-id': testUserId },
      payload: { name: `fk-int-${Date.now()}` },
    });
    if (initRes.statusCode !== 200 && initRes.statusCode !== 201) {
      throw new Error(`/init failed: ${initRes.statusCode} ${initRes.body}`);
    }
    fkAppId = initRes.json().app_id;
    fkOtherAppId = `app_${'z'.repeat(12)}`;

    // Wait for provisioning if needed (mirror what existing harness does).
    for (let i = 0; i < 30; i++) {
      const a = await fkApp.inject({ method: 'GET', url: `/apps/${fkAppId}/status` });
      if (a.json().provisioning_status === 'ready') break;
      await new Promise((r) => setTimeout(r, 200));
    }

    const svc = new KvCredentialsService(fkApp.controlDb);
    const cred = await svc.provision(fkAppId, 'us-east-1');
    fsk = cred.kv_function_key;
  });

  afterAll(async () => {
    await fkApp.close();
  });

  it('accepts FSK + body.userId and reaches the tool executor (not 401)', async () => {
    const res = await fkApp.inject({
      method: 'POST',
      url: `/v1/${fkAppId}/integrations/execute`,
      headers: { authorization: `Bearer ${fsk}` },
      payload: {
        toolName: 'GOOGLESUPER_FIND_EVENT',
        params: { query: 'x' },
        userId: someAppUserId,
      },
    });
    // We do not assert success against a live Composio backend — only that
    // the request got past auth. Acceptable: 200 OR any 4xx/5xx whose error
    // code starts with INTEGRATIONS_. The fail mode is 401 AUTH_*.
    expect(res.statusCode).not.toBe(401);
    if (res.statusCode >= 400) {
      const code = res.json()?.error?.code ?? '';
      expect(code.startsWith('AUTH_')).toBe(false);
    }
  });

  it('rejects FSK without body.userId (4xx with VALIDATION or missing-user error)', async () => {
    const res = await fkApp.inject({
      method: 'POST',
      url: `/v1/${fkAppId}/integrations/execute`,
      headers: { authorization: `Bearer ${fsk}` },
      payload: { toolName: 'GOOGLESUPER_FIND_EVENT', params: {} },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    const code = res.json()?.error?.code ?? '';
    expect(code).toMatch(/VALIDATION|USER|REQUIRED/);
  });

  it('rejects FSK from a different app (401)', async () => {
    const res = await fkApp.inject({
      method: 'POST',
      url: `/v1/${fkOtherAppId}/integrations/execute`,
      headers: { authorization: `Bearer ${fsk}` },
      payload: { toolName: 'GOOGLESUPER_FIND_EVENT', params: {}, userId: someAppUserId },
    });
    expect(res.statusCode).toBe(401);
  });
});
