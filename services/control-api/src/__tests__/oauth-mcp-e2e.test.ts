process.env.BUTTERBASE_E2E = '1';

import crypto, { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { OAuthStateService } from '../services/oauth-state-service.js';

// Mock ApiKeyService so /oauth/token can mint without a real DB/Redis. The mock
// records each minted key in a Map so the same in-process key can be validated
// later by the MCP route in the round-trip test.
const mintedKeys = new Map<string, { userId: string; scopes: string[]; keyId: string }>();
vi.mock('../services/api-key-service.js', () => ({
  ApiKeyService: {
    generateApiKey: vi.fn(async (
      _pool: unknown,
      userId: string,
      _name: string,
      options: { keyScope?: 'account' | 'app'; targetAppId?: string; additionalScopes?: string[] } = {},
    ) => {
      const fullKey = `bb_sk_${crypto.randomBytes(20).toString('hex')}`;
      const keyId = `k_${crypto.randomBytes(8).toString('hex')}`;
      const scopes = options.keyScope === 'app'
        ? [`app:${options.targetAppId}`, ...(options.additionalScopes ?? [])]
        : ['*', ...(options.additionalScopes ?? [])];
      mintedKeys.set(fullKey, { userId, scopes, keyId });
      return { key: fullKey, keyId, prefix: fullKey.substring(0, 12), name: _name };
    }),
    validateApiKey: vi.fn(async (_pool: unknown, key: string) => {
      const found = mintedKeys.get(key);
      if (!found) return null;
      return { userId: found.userId, authMethod: 'api_key', scopes: found.scopes, keyId: found.keyId };
    }),
  },
}));

// Auth plugin / api-key-service touch redis for caching. No-op it.
vi.mock('../services/redis.js', () => ({
  getRedisClient: () => ({
    get: async () => null,
    setex: async () => 'OK',
  }),
}));

process.env.DASHBOARD_URL = 'http://localhost:5173';

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
        return { rows: [] };
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

async function buildTestApp() {
  const app = Fastify({ logger: false });
  app.decorate('controlDb', makePoolStub() as any);
  const authPlugin = (await import('../plugins/auth.js')).default;
  const { oauthRoutes } = await import('../routes/oauth.js');
  const { mcpRoutes } = await import('../routes/mcp.js');
  await app.register(authPlugin);
  await app.register(oauthRoutes);
  await app.register(mcpRoutes);
  return app;
}

describe('OAuth → MCP end-to-end', () => {
  it('registers, consents, exchanges, calls /mcp tools/list', async () => {
    const app = await buildTestApp();

    // 1. DCR — register an OAuth client
    const reg = await app.inject({
      method: 'POST',
      url: '/oauth/register',
      payload: { client_name: 'E2E', redirect_uris: ['http://127.0.0.1:11111/cb'] },
    });
    expect(reg.statusCode).toBe(201);
    const client = reg.json();
    expect(client.client_id).toMatch(/^mcp_/);

    // 2. Build a signed state token (skips the browser/dashboard hop)
    const verifier = crypto.randomBytes(32).toString('base64url');
    const code_challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const st = OAuthStateService.sign({
      client_id: client.client_id,
      redirect_uri: 'http://127.0.0.1:11111/cb',
      scope: 'mcp',
      state: 'e2e',
      code_challenge,
    });

    // 3. Consent — user approves via x-test-user-id (BUTTERBASE_E2E=1 path)
    const userId = randomUUID();
    const decide = await app.inject({
      method: 'POST',
      url: '/oauth/authorize/decide',
      headers: { 'x-test-user-id': userId, 'content-type': 'application/json' },
      payload: { st, decision: 'approve', target: { key_scope: 'account', additional_scopes: [] } },
    });
    expect(decide.statusCode).toBe(200);
    const code = new URL(decide.json().redirect_to).searchParams.get('code')!;
    expect(code).toBeTruthy();

    // 4. Token exchange — PKCE verifier → bb_sk_* access token
    const tok = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: { 'content-type': 'application/json' },
      payload: {
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'http://127.0.0.1:11111/cb',
        client_id: client.client_id,
        code_verifier: verifier,
      },
    });
    expect(tok.statusCode).toBe(200);
    const access_token = tok.json().access_token;
    expect(access_token).toMatch(/^bb_sk_/);

    // 5. MCP initialize — confirm the minted token authenticates
    const init = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${access_token}`,
      },
      payload: {
        jsonrpc: '2.0',
        method: 'initialize',
        id: 1,
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'e2e', version: '1' },
        },
      },
    });
    expect(init.statusCode).toBe(200);

    // 6. MCP tools/list — verify the full tool catalogue is served
    const tools = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${access_token}`,
      },
      payload: { jsonrpc: '2.0', method: 'tools/list', id: 2 },
    });
    expect(tools.statusCode).toBe(200);
    // Response is SSE: "event: message\ndata: {...}\n\n"
    const match = tools.body.match(/data: (\{.+\})/);
    expect(match).toBeTruthy();
    const parsed = JSON.parse(match![1]);
    expect(Array.isArray(parsed.result?.tools)).toBe(true);
    expect(parsed.result.tools.length).toBeGreaterThan(10);

    await app.close();
  });
});
