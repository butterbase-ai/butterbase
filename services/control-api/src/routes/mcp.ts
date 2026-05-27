import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createButterbaseMcpServer, runWithRequestAuthorizationHeader } from '@butterbase/mcp-server';

async function handleMcp(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply
) {
  const server = await createButterbaseMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  transport.onerror = (error) => {
    // Most MCP transport errors are client misuse (bad Accept header, malformed
    // body, etc.) returning 4xx — log at warn so they don't pollute platform alerting.
    app.log.warn({ err: error }, 'MCP transport error');
  };

  try {
    await server.connect(transport);
    reply.hijack();
    const authorizationHeader = typeof request.headers.authorization === 'string'
      ? request.headers.authorization
      : undefined;

    await runWithRequestAuthorizationHeader(authorizationHeader, async () => {
      await transport.handleRequest(request.raw, reply.raw, request.body);
    });
  } catch (error) {
    app.log.error({ err: error }, 'MCP request handling failed');
    if (!reply.raw.headersSent) {
      reply.raw.statusCode = 500;
      reply.raw.setHeader('content-type', 'application/json');
      reply.raw.end(JSON.stringify({ error: 'MCP request failed' }));
    }
  }
}

export async function mcpRoutes(app: FastifyInstance) {
  // We don't use server-initiated notifications (no setNotificationHandler calls,
  // tools are all request/response). The standalone GET SSE stream therefore stays
  // idle forever and silently dies on network changes / laptop sleep, leaving the
  // client wedged with no signal to reconnect. Reject GET so clients fall back to
  // POST-only mode (per MCP Streamable HTTP spec, GET support is optional).
  app.route({
    method: 'GET',
    url: '/mcp',
    handler: async (_request, reply) => {
      reply
        .code(405)
        .header('allow', 'POST, DELETE')
        .header('content-type', 'application/json')
        .send({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Method Not Allowed: server does not support GET SSE stream' },
          id: null,
        });
    },
  });

  app.route({
    method: ['POST', 'DELETE'],
    url: '/mcp',
    handler: async (request, reply) => handleMcp(app, request, reply),
  });
}
