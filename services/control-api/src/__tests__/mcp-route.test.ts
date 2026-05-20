import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import authPlugin from '../plugins/auth.js';
import { mcpRoutes } from '../routes/mcp.js';

describe('MCP route', () => {
  describe('POST /mcp without auth plugin', () => {
    const app = Fastify();

    beforeAll(async () => {
      app.register(mcpRoutes);
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
      app.register(authPlugin);
      app.register(mcpRoutes);
      await app.ready();
    });

    afterAll(async () => {
      await app.close();
    });

    it('requires Bearer auth header', async () => {
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
      expect(res.json()).toEqual({
        error: 'Missing or invalid Authorization header',
      });
    });
  });
});
