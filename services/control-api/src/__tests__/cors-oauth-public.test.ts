import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';

// The DB-backed allowlist in the default CORS policy would try to reach every
// configured runtime region. Nothing here exercises that path — these tests are
// about the public-path carve-out — so stub the pool rather than requiring a DB.
vi.mock('../services/runtime-db.js', () => ({
  getRuntimeDbPool: () => ({ query: async () => ({ rows: [] }) }),
}));

const FOREIGN_ORIGIN = 'http://localhost:6274'; // MCP Inspector's default

async function buildAppForTest() {
  const { default: corsPlugin } = await import('../plugins/cors.js');
  const app = Fastify({ logger: false });
  await app.register(corsPlugin);
  for (const url of ['/.well-known/oauth-protected-resource', '/oauth/register', '/oauth/token', '/mcp']) {
    app.route({ method: ['GET', 'POST'], url, handler: async (_r, reply) => reply.send({ ok: true }) });
  }
  app.route({ method: 'GET', url: '/v1/apps', handler: async (_r, reply) => reply.send({ ok: true }) });
  return app;
}

describe('CORS carve-out for OAuth discovery and MCP', () => {
  // A browser-hosted MCP client (MCP Inspector, web-hosted agents) has to be
  // able to read discovery metadata, register, exchange a token AND then call
  // /mcp. Our default policy is an allowlist backed by apps.allowed_origins,
  // which admits none of them.
  it.each([
    '/.well-known/oauth-protected-resource',
    '/oauth/register',
    '/oauth/token',
    '/mcp',
  ])('reflects an arbitrary origin on %s', async (url) => {
    const app = await buildAppForTest();
    const res = await app.inject({ method: 'GET', url, headers: { origin: FOREIGN_ORIGIN } });
    expect(res.headers['access-control-allow-origin']).toBe(FOREIGN_ORIGIN);
    // Reflecting an arbitrary origin is only safe with credentials off.
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    await app.close();
  });

  // Without this the whole RFC 9728 handshake is unusable from a browser:
  // WWW-Authenticate is not CORS-safelisted, and it is what carries
  // resource_metadata.
  it('exposes WWW-Authenticate so a browser client can read the challenge', async () => {
    const app = await buildAppForTest();
    const res = await app.inject({ method: 'GET', url: '/mcp', headers: { origin: FOREIGN_ORIGIN } });
    expect(res.headers['access-control-expose-headers']).toContain('WWW-Authenticate');
    await app.close();
  });

  it('still applies the allowlist to everything outside the carve-out', async () => {
    const app = await buildAppForTest();
    const res = await app.inject({ method: 'GET', url: '/v1/apps', headers: { origin: FOREIGN_ORIGIN } });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    await app.close();
  });
});
