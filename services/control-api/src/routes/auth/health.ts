import type { FastifyInstance } from 'fastify';

export async function healthRoutes(app: FastifyInstance) {
  // Liveness probe - is the service running?
  app.get('/health', async () => {
    return { status: 'ok', service: 'auth-service' };
  });

  // Readiness probe - can the service handle requests?
  app.get('/health/ready', async (request, reply) => {
    try {
      // Check database connectivity
      await app.controlDb.query('SELECT 1');

      return {
        status: 'ready',
        service: 'auth-service',
        checks: {
          database: 'ok',
        },
      };
    } catch (error) {
      app.log.error({ error }, 'Readiness check failed');
      return reply.code(503).send({
        status: 'not_ready',
        service: 'auth-service',
        checks: {
          database: 'failed',
        },
      });
    }
  });
}
