import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';

export async function healthRoutes(app: FastifyInstance) {
  // Liveness probe
  app.get('/health', {
    config: { public: true }
  }, async () => {
    return { status: 'ok', service: 'control-api' };
  });

  // Readiness probe
  app.get('/health/ready', {
    config: { public: true }
  }, async (request, reply) => {
    const checks: Record<string, string> = {};
    try {
      await app.controlDb.query('SELECT 1');
      checks.controlDb = 'ok';

      // Only check local data-plane DB when Neon is disabled (local dev).
      // In production, per-app databases live in Neon — there is no local data-plane.
      if (!config.neon.enabled) {
        await app.dataPlaneDb.query('SELECT 1');
        checks.dataPlaneDb = 'ok';
      }

      return {
        status: 'ready',
        service: 'control-api',
        checks,
      };
    } catch (error) {
      app.log.error({ error }, 'Readiness check failed');
      return reply.code(503).send({
        status: 'not_ready',
        service: 'control-api',
        checks,
      });
    }
  });
}
