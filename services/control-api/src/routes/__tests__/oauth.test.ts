process.env.BUTTERBASE_E2E = '1';

import crypto, { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { oauthRoutes } from '../oauth.js';
import authPlugin from '../../plugins/auth.js';
import { OAuthStateService } from '../../services/oauth-state-service.js';

// Mock ApiKeyService so /oauth/token can mint without a real DB/Redis. The mock
// records each minted key in a Map so the same in-process key can be validated
// later by the MCP route in the round-trip test.
const mintedKeys = new Map<string, { userId: string; scopes: string[]; keyId: string }>();
vi.mock('../../services/api-key-service.js', () => ({
  ApiKeyService: {
    generateApiKey: vi.fn(async (
      _pool: unknown,
      userId: string,
      name: string,
      options: { keyScope?: 'account' | 'app'; targetAppId?: string; additionalScopes?: string[] } = {},
    ) => {
      const fullKey = `bb_sk_${crypto.randomBytes(20).toString('hex')}`;
      const keyId = `k_${crypto.randomBytes(8).toString('hex')}`;
      const scopes = options.keyScope === 'app'
        ? [`app:${options.targetAppId}`, ...(options.additionalScopes ?? [])]
        : ['*', ...(options.additionalScopes ?? [])];
      mintedKeys.set(fullKey, { userId, scopes, keyId });
      return { key: fullKey, keyId, prefix: fullKey.substring(0, 12), name };
    }),
    validateApiKey: vi.fn(async (_pool: unknown, key: string) => {
      const found = mintedKeys.get(key);
      if (!found) return null;
      return { userId: found.userId, authMethod: 'api_key', scopes: found.scopes, keyId: found.keyId };
    }),
  },
}));

// Auth plugin / api-key-service touch redis for caching. No-op it.
vi.mock('../../services/redis.js', () => ({
  getRedisClient: () => ({
    get: async () => null,
    setex: async () => 'OK',
  }),
}));

process.env.DASHBOARD_URL = 'http://localhost:5173';

let currentApps: Array<{ id: string; name: string }> = [];

function makePoolStub() {
  const clientsByClientId: Record<string, { client_id: string; client_name: string | null; redirect_uris: string[]; created_at: Date }> = {};
  type CodeRow = {
    code_hash: string;
    client_id: string;
    user_id: string;
    redirect_uri: string;
    scope: string;
    code_challenge: string;
    requested_target: unknown;
    expires_at: Date;
    consumed_at: Date | null;
  };
  const codesByHash = new Map<string, CodeRow>();
  return {
    query: vi.fn(async (sql: string, args: unknown[]) => {
      if (sql.startsWith('INSERT INTO oauth_clients')) {
        const row = { client_id: args[0] as string, client_name: args[1] as string | null, redirect_uris: args[2] as string[], created_at: new Date() };
        clientsByClientId[row.client_id] = row;
        return { rows: [row] };
      }
      if (sql.startsWith('SELECT client_id, client_name, redirect_uris, created_at FROM oauth_clients')) {
        const id = args[0] as string;
        return { rows: clientsByClientId[id] ? [clientsByClientId[id]] : [] };
      }
      if (sql.startsWith('INSERT INTO oauth_authorization_codes')) {
        const row: CodeRow = {
          code_hash: args[0] as string,
          client_id: args[1] as string,
          user_id: args[2] as string,
          redirect_uri: args[3] as string,
          scope: args[4] as string,
          code_challenge: args[5] as string,
          requested_target: args[6],
          expires_at: args[7] as Date,
          consumed_at: null,
        };
        codesByHash.set(row.code_hash, row);
        return { rows: [] };
      }
      if (sql.startsWith('UPDATE oauth_authorization_codes')) {
        const [code_hash, client_id, redirect_uri] = args as [string, string, string];
        const row = codesByHash.get(code_hash);
        if (!row) return { rows: [] };
        if (row.consumed_at) return { rows: [] };
        if (row.client_id !== client_id || row.redirect_uri !== redirect_uri) return { rows: [] };
        if (row.expires_at.getTime() <= Date.now()) return { rows: [] };
        row.consumed_at = new Date();
        return {
          rows: [{
            user_id: row.user_id,
            scope: row.scope,
            code_challenge: row.code_challenge,
            requested_target: row.requested_target,
          }],
        };
      }
      if (sql.startsWith('SELECT id, name FROM apps WHERE owner_id')) {
        return { rows: currentApps };
      }
      if (sql.startsWith('UPDATE oauth_clients SET last_used_at')) {
        return { rows: [] };
      }
      if (sql.startsWith('UPDATE api_keys SET expires_at')) {
        return { rows: [] };
      }
      return { rows: [] };
    }),
  };
}

async function buildAppForTest() {
  currentApps = [];
  const app = Fastify({ logger: false });
  app.decorate('controlDb', makePoolStub() as any);
  await app.register(authPlugin);
  await app.register(oauthRoutes);
  return app;
}

async function buildTestAppWithMcp() {
  currentApps = [];
  const app = Fastify({ logger: false });
  app.decorate('controlDb', makePoolStub() as any);
  await app.register(authPlugin);
  await app.register(oauthRoutes);
  const { mcpRoutes } = await import('../mcp.js');
  await app.register(mcpRoutes);
  return app;
}

async function prepareConsent(app: FastifyInstance) {
  const reg = await app.inject({
    method: 'POST', url: '/oauth/register',
    payload: { client_name: 'Claude Code', redirect_uris: ['http://127.0.0.1:55555/cb'] },
  });
  const client = reg.json();
  const userId = randomUUID();
  const st = OAuthStateService.sign({
    client_id: client.client_id,
    redirect_uri: 'http://127.0.0.1:55555/cb',
    scope: 'mcp',
    state: 'xyz',
    code_challenge: 'a'.repeat(43),
  });
  return { client, st, userId };
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

describe('GET /oauth/authorize/details', () => {
  it('returns client_name + scope + the user\'s apps', async () => {
    const app = await buildAppForTest();
    const { client, st, userId } = await prepareConsent(app);
    currentApps = [{ id: 'app_demo', name: 'Demo App' }];
    const res = await app.inject({
      method: 'GET',
      url: `/oauth/authorize/details?st=${encodeURIComponent(st)}`,
      headers: { 'x-test-user-id': userId },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.client_name).toBe(client.client_name);
    expect(body.scope).toBe('mcp');
    expect(body.redirect_uri).toBe('http://127.0.0.1:55555/cb');
    expect(Array.isArray(body.apps)).toBe(true);
    expect(body.apps).toEqual([{ id: 'app_demo', name: 'Demo App' }]);
    await app.close();
  });

  it('401s without auth', async () => {
    const app = await buildAppForTest();
    const { st } = await prepareConsent(app);
    const res = await app.inject({
      method: 'GET',
      url: `/oauth/authorize/details?st=${encodeURIComponent(st)}`,
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('400s on tampered st', async () => {
    const app = await buildAppForTest();
    const { userId } = await prepareConsent(app);
    const res = await app.inject({
      method: 'GET',
      url: `/oauth/authorize/details?st=tampered`,
      headers: { 'x-test-user-id': userId },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe('POST /oauth/authorize/decide', () => {
  it('approve returns redirect_to with code + state', async () => {
    const app = await buildAppForTest();
    const { client, st, userId } = await prepareConsent(app);
    const res = await app.inject({
      method: 'POST',
      url: '/oauth/authorize/decide',
      headers: { 'x-test-user-id': userId },
      payload: { st, decision: 'approve', target: { key_scope: 'account', additional_scopes: [] } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.redirect_to).toContain(client.redirect_uris[0]);
    expect(body.redirect_to).toMatch(/code=[A-Za-z0-9_-]+/);
    expect(body.redirect_to).toMatch(/state=xyz/);
    await app.close();
  });

  it('deny returns redirect_to with error=access_denied', async () => {
    const app = await buildAppForTest();
    const { st, userId } = await prepareConsent(app);
    const res = await app.inject({
      method: 'POST',
      url: '/oauth/authorize/decide',
      headers: { 'x-test-user-id': userId },
      payload: { st, decision: 'deny' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.redirect_to).toContain('error=access_denied');
    expect(body.redirect_to).toContain('state=xyz');
    await app.close();
  });
});

describe('POST /oauth/token', () => {
  async function fullFlow(app: FastifyInstance, keyScope: 'account' | 'app' = 'account', target_app_id?: string) {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const code_challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const reg = await app.inject({
      method: 'POST', url: '/oauth/register',
      payload: { client_name: 'Claude Code', redirect_uris: ['http://127.0.0.1:55555/cb'] },
    });
    const client = reg.json();
    const userId = randomUUID();
    const st = OAuthStateService.sign({
      client_id: client.client_id,
      redirect_uri: 'http://127.0.0.1:55555/cb',
      scope: 'mcp',
      state: 'xyz',
      code_challenge,
    });
    const decide = await app.inject({
      method: 'POST', url: '/oauth/authorize/decide',
      headers: { 'x-test-user-id': userId },
      payload: { st, decision: 'approve', target: { key_scope: keyScope, target_app_id, additional_scopes: [] } },
    });
    const code = new URL(decide.json().redirect_to).searchParams.get('code')!;
    return { client, verifier, code, userId };
  }

  it('exchanges code + verifier for a bb_sk_ token', async () => {
    const app = await buildAppForTest();
    const { client, verifier, code } = await fullFlow(app);
    const res = await app.inject({
      method: 'POST', url: '/oauth/token',
      headers: { 'content-type': 'application/json' },
      payload: { grant_type: 'authorization_code', code, redirect_uri: 'http://127.0.0.1:55555/cb', client_id: client.client_id, code_verifier: verifier },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.access_token).toMatch(/^bb_sk_/);
    expect(body.token_type).toBe('Bearer');
    expect(body.expires_in).toBeGreaterThan(7_000_000);
    expect(body.scope).toBe('mcp');
    await app.close();
  });

  it('rejects wrong verifier with invalid_grant', async () => {
    const app = await buildAppForTest();
    const { client, code } = await fullFlow(app);
    const res = await app.inject({
      method: 'POST', url: '/oauth/token',
      headers: { 'content-type': 'application/json' },
      payload: { grant_type: 'authorization_code', code, redirect_uri: 'http://127.0.0.1:55555/cb', client_id: client.client_id, code_verifier: 'wrong' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_grant');
    await app.close();
  });

  it('issued token works on POST /mcp', async () => {
    const app = await buildTestAppWithMcp();
    const { client, verifier, code } = await fullFlow(app);
    const tok = (await app.inject({
      method: 'POST', url: '/oauth/token',
      headers: { 'content-type': 'application/json' },
      payload: { grant_type: 'authorization_code', code, redirect_uri: 'http://127.0.0.1:55555/cb', client_id: client.client_id, code_verifier: verifier },
    })).json().access_token;
    const mcp = await app.inject({
      method: 'POST', url: '/mcp',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${tok}` },
      payload: { jsonrpc: '2.0', method: 'initialize', id: 1, params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
    });
    expect(mcp.statusCode).toBe(200);
    await app.close();
  });
});
