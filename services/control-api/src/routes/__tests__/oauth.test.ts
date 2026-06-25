import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { oauthRoutes } from '../oauth.js';

async function buildAppForTest() {
  const app = Fastify({ logger: false });
  // Pool stub: validate() in OAuthClientService runs synchronously before the query.
  // We stub only the DB I/O so the real validation path is exercised.
  const poolStub = {
    query: vi.fn(async (_sql: string, args: unknown[]) => ({
      rows: [{
        client_id: args[0],
        client_name: args[1],
        redirect_uris: args[2],
        created_at: new Date(),
      }],
    })),
  };
  app.decorate('controlDb', poolStub as any);
  await app.register(oauthRoutes);
  return app;
}

describe('POST /oauth/register (DCR)', () => {
  it('issues a client_id for a valid registration', async () => {
    const app = await buildAppForTest();
    const res = await app.inject({
      method: 'POST', url: '/oauth/register',
      payload: { client_name: 'Claude Code', redirect_uris: ['http://127.0.0.1:33333/cb'] },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.client_id).toMatch(/^mcp_/);
    expect(body.token_endpoint_auth_method).toBe('none');
    expect(body.redirect_uris).toEqual(['http://127.0.0.1:33333/cb']);
    await app.close();
  });

  it('400s on invalid redirect_uri', async () => {
    const app = await buildAppForTest();
    const res = await app.inject({
      method: 'POST', url: '/oauth/register',
      payload: { redirect_uris: ['http://evil.example/cb'] },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('400s when redirect_uris is missing', async () => {
    const app = await buildAppForTest();
    const res = await app.inject({ method: 'POST', url: '/oauth/register', payload: {} });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
