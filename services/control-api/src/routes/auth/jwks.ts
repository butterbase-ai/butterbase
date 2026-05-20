import type { FastifyInstance } from 'fastify';
import { apiError } from '../../utils/api-error.js';
import { getPublicKeysForJwks } from '../../services/auth/signing-key-service.js';

export async function jwksRoutes(app: FastifyInstance) {
  app.get('/auth/:app_id/.well-known/jwks.json', {
    config: { public: true },
  }, async (request, reply) => {
    const { app_id } = request.params as { app_id: string };

    try {
      const keys = await getPublicKeysForJwks(app.controlDb, app_id);

      // Set cache headers (5 minutes)
      reply.header('Cache-Control', 'public, max-age=300');

      return { keys };
    } catch (error) {
      app.log.error({ error }, 'JWKS fetch failed');
      return reply.code(500).send(apiError(error, 'Internal server error'));
    }
  });
}
