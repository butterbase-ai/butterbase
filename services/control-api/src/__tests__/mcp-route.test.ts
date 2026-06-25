import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import fp from 'fastify-plugin';

// Mock ApiKeyService BEFORE importing the auth plugin so the plugin sees the
// mocked module. This keeps the test independent of a live control-plane DB
// (the auth plugin only calls ApiKeyService.validateApiKey for bb_sk_ keys).
vi.mock('../services/api-key-service.js', () => ({
  ApiKeyService: {
    validateApiKey: vi.fn(async (_pool: unknown, key: string) => {
      if (key === 'bb_sk_validtest0000000000000000000000000000') {
        return {
          userId: 'u_test',
          authMethod: 'api_key',
          scopes: ['*'],
        };
      }
      return null;
    }),
  },
}));

// The auth plugin also touches getRedisClient() for the function-key cache
// path. Make it a no-op so unit tests don't need a live redis.
vi.mock('../services/redis.js', () => ({
  getRedisClient: () => ({
    get: async () => null,
    setex: async () => 'OK',
  }),
}));

const authPluginPromise = import('../plugins/auth.js').then((m) => m.default);
const mcpRoutesPromise = import('../routes/mcp.js').then((m) => m.mcpRoutes);

describe('MCP route', () => {
  describe('POST /mcp without auth plugin', () => {
    const app = Fastify();

    beforeAll(async () => {
      app.register(await mcpRoutesPromise);
      await app.ready();
    });

    afterAll(async () => {
      await app.close();
    });

    it('accepts initialize request', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        payload: {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: {
              name: 'control-api-test',
              version: '1.0.0',
            },
          },
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('event: message');
      expect(res.body).toContain('"protocolVersion":"2024-11-05"');
    });
  });

  describe('POST /mcp with auth plugin', () => {
    const app = Fastify();

    beforeAll(async () => {
      // Auth plugin calls fastify.controlDb in some branches. The validateApiKey
      // path is mocked above, so a stub pool is sufficient.
      app.register(
        fp(async (fastify) => {
          (fastify as unknown as { controlDb: unknown }).controlDb = {
            query: async () => ({ rows: [] }),
          };
        }),
      );
      app.register(await authPluginPromise);
      app.register(await mcpRoutesPromise);
      await app.ready();
    });

    afterAll(async () => {
      await app.close();
    });

    it('requires Bearer auth header — returns 401 with WWW-Authenticate', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: {
          accept: 'application/json, text/event-stream',
        },
        payload: {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: {
              name: 'control-api-test',
              version: '1.0.0',
            },
          },
        },
      });

      expect(res.statusCode).toBe(401);
      const www = res.headers['www-authenticate'];
      expect(typeof www).toBe('string');
      expect(www as string).toMatch(/^Bearer /);
      expect(www as string).toContain('realm="butterbase"');
      expect(www as string).toContain('resource_metadata="');
      expect(www as string).toMatch(/\/\.well-known\/oauth-protected-resource"/);
      const body = res.json();
      expect(body.error?.code).toBe('AUTH_REQUIRED');
    });

    it('returns 401 + WWW-Authenticate for an invalid bb_sk_ key', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: {
          accept: 'application/json, text/event-stream',
          authorization: 'Bearer bb_sk_definitelynotarealkey00000000000000000',
        },
        payload: {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'control-api-test', version: '1.0.0' },
          },
        },
      });

      expect(res.statusCode).toBe(401);
      expect(res.headers['www-authenticate']).toMatch(/^Bearer /);
      expect(res.json().error?.code).toBe('AUTH_REQUIRED');
    });

    it('returns 200 for a valid bb_sk_ key', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: 'Bearer bb_sk_validtest0000000000000000000000000000',
        },
        payload: {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'control-api-test', version: '1.0.0' },
          },
        },
      });

      expect(res.statusCode).toBe(200);
    });
  });
});
