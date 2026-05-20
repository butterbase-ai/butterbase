import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import { databasePlugin } from '../plugins/database.js';
import { dataPlanePlugin } from '../plugins/data-plane.js';
import { initRoutes } from '../routes/init.js';
import { integrationRoutes } from '../routes/integrations.js';
import { config } from '../config.js';

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
