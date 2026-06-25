import type { FastifyInstance } from 'fastify';

function baseUrl(): string {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL;
  const port = process.env.CONTROL_API_PORT ?? '4000';
  return `http://localhost:${port}`;
}

export async function wellKnownRoutes(app: FastifyInstance) {
  // RFC 9728 — identifies /mcp as a protected resource and points to the AS.
  app.route({
    method: 'GET',
    url: '/.well-known/oauth-protected-resource',
    config: { public: true },
    handler: async (_req, reply) => {
      const base = baseUrl();
      reply.send({
        resource: `${base}/mcp`,
        authorization_servers: [base],
        scopes_supported: ['mcp', 'ai:gateway'],
        bearer_methods_supported: ['header'],
        resource_documentation: 'https://docs.butterbase.ai/mcp',
      });
    },
  });

  // RFC 8414 — authorization server metadata.
  app.route({
    method: 'GET',
    url: '/.well-known/oauth-authorization-server',
    config: { public: true },
    handler: async (_req, reply) => {
      const base = baseUrl();
      reply.send({
        issuer: base,
        authorization_endpoint: `${base}/oauth/authorize`,
        token_endpoint: `${base}/oauth/token`,
        registration_endpoint: `${base}/oauth/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code'],
        code_challenge_methods_supported: ['S256'],
        scopes_supported: ['mcp', 'ai:gateway'],
        token_endpoint_auth_methods_supported: ['none'],
      });
    },
  });
}
