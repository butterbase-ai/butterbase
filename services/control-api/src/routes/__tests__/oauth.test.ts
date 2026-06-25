import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { oauthRoutes } from '../oauth.js';

process.env.DASHBOARD_URL = 'http://localhost:5173';

async function buildAppForTest() {
  const app = Fastify({ logger: false });
  const clientsByClientId: Record<string, { client_id: string; client_name: string | null; redirect_uris: string[]; created_at: Date }> = {};
  const poolStub = {
    query: vi.fn(async (sql: string, args: unknown[]) => {
      if (sql.startsWith('INSERT INTO oauth_clients')) {
        const row = { client_id: args[0] as string, client_name: args[1] as string | null, redirect_uris: args[2] as string[], created_at: new Date() };
        clientsByClientId[row.client_id] = row;
        return { rows: [row] };
      }
      if (sql.startsWith('SELECT client_id, client_name, redirect_uris, created_at FROM oauth_clients')) {
        const id = (args[0] as string);
        return { rows: clientsByClientId[id] ? [clientsByClientId[id]] : [] };
      }
      return { rows: [] };
    }),
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

describe('GET /oauth/authorize', () => {
  async function registerClient(app: any, redirect_uri = 'http://127.0.0.1:55555/cb') {
    const reg = await app.inject({
      method: 'POST', url: '/oauth/register',
      payload: { client_name: 't', redirect_uris: [redirect_uri] },
    });
    return reg.json();
  }

  it('redirects to the dashboard consent page with a signed state token', async () => {
    const app = await buildAppForTest();
    const client = await registerClient(app);
    const res = await app.inject({
      method: 'GET',
      url: `/oauth/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent('http://127.0.0.1:55555/cb')}&code_challenge=${'a'.repeat(43)}&code_challenge_method=S256&scope=mcp&state=xyz`,
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toMatch(/\/oauth\/consent\?st=/);
    await app.close();
  });

  it('400s on unregistered redirect_uri', async () => {
    const app = await buildAppForTest();
    const client = await registerClient(app);
    const res = await app.inject({
      method: 'GET',
      url: `/oauth/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent('http://attacker.example/cb')}&code_challenge=${'a'.repeat(43)}&code_challenge_method=S256&scope=mcp&state=xyz`,
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('400s on missing code_challenge', async () => {
    const app = await buildAppForTest();
    const client = await registerClient(app);
    const res = await app.inject({
      method: 'GET',
      url: `/oauth/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent('http://127.0.0.1:55555/cb')}&code_challenge_method=S256&scope=mcp&state=xyz`,
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('400s on unknown client_id', async () => {
    const app = await buildAppForTest();
    const res = await app.inject({
      method: 'GET',
      url: `/oauth/authorize?response_type=code&client_id=mcp_doesnotexist&redirect_uri=${encodeURIComponent('http://127.0.0.1:55555/cb')}&code_challenge=${'a'.repeat(43)}&code_challenge_method=S256&scope=mcp&state=xyz`,
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
