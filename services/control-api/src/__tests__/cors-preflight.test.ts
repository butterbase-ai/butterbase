import { describe, expect, it, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

// Disallowed-origin checks fall through to the DB-backed allowlist. Nothing
// here exercises real apps, so stub the pool to always report no match.
vi.mock('../services/runtime-db.js', () => ({
  getRuntimeDbPool: () => ({ query: async () => ({ rows: [] }) }),
}));

beforeEach(() => vi.resetModules());

const ALLOWED_ORIGIN = 'https://dashboard.cors-preflight-test.example.com';
const DISALLOWED_ORIGIN = 'https://evil.example.com';

async function buildAppForTest() {
  // Set explicitly (rather than relying on config's default) so this test
  // isn't affected by another test file in the same worker leaving
  // DASHBOARD_URL set to something else.
  process.env.DASHBOARD_URL = ALLOWED_ORIGIN;
  const { default: corsPlugin } = await import('../plugins/cors.js');
  const app = Fastify({ logger: false });
  await app.register(corsPlugin);
  app.route({ method: 'GET', url: '/v1/app_123/widgets', handler: async (_r, reply) => reply.send({ ok: true }) });
  return app;
}

function preflight(app: Awaited<ReturnType<typeof buildAppForTest>>, origin: string) {
  return app.inject({
    method: 'OPTIONS',
    url: '/v1/app_123/widgets',
    headers: { origin, 'access-control-request-method': 'GET' },
  });
}

describe('CORS preflight', () => {
  it('sets Access-Control-Max-Age on an allowed-origin preflight', async () => {
    const app = await buildAppForTest();
    const res = await preflight(app, ALLOWED_ORIGIN);
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
    expect(res.headers['access-control-max-age']).toBe('7200');
    await app.close();
  });

  it('returns 204 with no Access-Control-Allow-Origin for a disallowed-origin preflight', async () => {
    const app = await buildAppForTest();
    const res = await preflight(app, DISALLOWED_ORIGIN);
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    await app.close();
  });

  it('gives a normal GET from a disallowed origin no Access-Control-Allow-Origin', async () => {
    const app = await buildAppForTest();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/app_123/widgets',
      headers: { origin: DISALLOWED_ORIGIN },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    await app.close();
  });
});
