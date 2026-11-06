import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// A denied origin falls through to the DB-backed app allowlist. This test has
// no real apps, so the pool always reports "no match".
vi.mock('../services/runtime-db.js', () => ({
  getRuntimeDbPool: () => ({ query: async () => ({ rows: [] }) }),
}));

const ORIGINAL_ENV = { ...process.env };
const LEGACY = 'https://office-demo.example.test';
const CUSTOMER = 'https://office-customer.example.test';
const ALT = 'https://office-alt.example.test';
const UNRELATED = 'https://evil.example.test';

beforeEach(() => {
  vi.resetModules();
  delete process.env.OFFICE_URL;
  delete process.env.OFFICE_ALLOWED_ORIGINS;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

async function buildApp(env: { officeUrl?: string; allowed?: string }): Promise<FastifyInstance> {
  if (env.officeUrl) process.env.OFFICE_URL = env.officeUrl;
  if (env.allowed) process.env.OFFICE_ALLOWED_ORIGINS = env.allowed;
  const { default: corsPlugin } = await import('../plugins/cors.js');
  const app = Fastify({ logger: false });
  await app.register(corsPlugin);
  app.get('/v1/me/office', async () => ({ status: 'enabled' }));
  await app.ready();
  return app;
}

function get(app: FastifyInstance, origin: string) {
  return app.inject({
    method: 'GET',
    url: '/v1/me/office',
    headers: { origin },
  });
}

describe('Office origins in CORS', () => {
  it('allows both configured Office origins and the legacy OFFICE_URL, but nothing else', async () => {
    const app = await buildApp({ officeUrl: LEGACY, allowed: `${CUSTOMER}, ${ALT}` });

    for (const origin of [LEGACY, CUSTOMER, ALT]) {
      const res = await get(app, origin);
      expect(res.statusCode).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe(origin);
    }

    const denied = await get(app, UNRELATED);
    expect(denied.statusCode).toBe(200);
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();

    await app.close();
  });

  it('falls back to the single legacy origin when the list is unset', async () => {
    const app = await buildApp({ officeUrl: LEGACY });

    const allowed = await get(app, LEGACY);
    expect(allowed.headers['access-control-allow-origin']).toBe(LEGACY);

    const denied = await get(app, CUSTOMER);
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();

    await app.close();
  });

  it('answers preflight with the Office origin and the organization/auth headers', async () => {
    const app = await buildApp({ officeUrl: LEGACY, allowed: CUSTOMER });

    const res = await app.inject({
      method: 'OPTIONS',
      url: '/v1/me/office',
      headers: {
        origin: CUSTOMER,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,x-organization-id',
      },
    });

    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(CUSTOMER);
    const allowedHeaders = String(res.headers['access-control-allow-headers']).toLowerCase();
    expect(allowedHeaders).toContain('authorization');
    expect(allowedHeaders).toContain('x-organization-id');

    await app.close();
  });
});
