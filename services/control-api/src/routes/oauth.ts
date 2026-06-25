import type { FastifyInstance } from 'fastify';
import { OAuthClientService } from '../services/oauth-client-service.js';

export async function oauthRoutes(app: FastifyInstance) {
  app.route({
    method: 'POST',
    url: '/oauth/register',
    config: { public: true },
    handler: async (request, reply) => {
      const body = (request.body ?? {}) as { client_name?: unknown; redirect_uris?: unknown };
      const redirect_uris = body.redirect_uris;
      const client_name = body.client_name;
      if (!Array.isArray(redirect_uris)) {
        return reply.code(400).send({ error: 'invalid_redirect_uri', error_description: 'redirect_uris is required and must be an array' });
      }
      try {
        const out = await OAuthClientService.register(app.controlDb, {
          redirect_uris: redirect_uris as string[],
          client_name: typeof client_name === 'string' ? client_name : undefined,
        });
        return reply.code(201).send({
          client_id: out.client_id,
          client_name: out.client_name,
          redirect_uris: out.redirect_uris,
          client_id_issued_at: Math.floor(out.created_at.getTime() / 1000),
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code'],
          response_types: ['code'],
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'invalid request';
        return reply.code(400).send({ error: 'invalid_client_metadata', error_description: message });
      }
    },
  });
}
