import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';

// Source of truth for the public URL used in oauth metadata. Must agree with
// the WWW-Authenticate `resource_metadata` URL emitted by plugins/auth.ts so
// clients discover the same authorization server.
function baseUrl(): string {
  return (config as { publicUrl?: string }).publicUrl
    ?? `http://localhost:${(config as { port?: number }).port ?? 4000}`;
}

export async function wellKnownRoutes(app: FastifyInstance) {
  const protectedResourceMetadata = (base: string) => ({
    resource: `${base}/mcp`,
    authorization_servers: [base],
    scopes_supported: ['mcp', 'ai:gateway'],
    bearer_methods_supported: ['header'],
    resource_documentation: 'https://docs.butterbase.ai/getting-started/mcp-setup/',
  });

  // RFC 9728 — identifies /mcp as a protected resource and points to the AS.
  // Served at BOTH the root form and the path-inserted form. §3.1 defines the
  // well-known URI for a resource identifier that has a path component
  // (https://host/mcp) as /.well-known/oauth-protected-resource/mcp — clients
  // that probe discovery directly, instead of reading resource_metadata off the
  // WWW-Authenticate challenge, only ever look at the path-inserted URL.
  for (const url of [
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-protected-resource/mcp',
  ]) {
    app.route({
      method: 'GET',
      url,
      config: { public: true },
      handler: async (_req, reply) => {
        reply.send(protectedResourceMetadata(baseUrl()));
      },
    });
  }

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
