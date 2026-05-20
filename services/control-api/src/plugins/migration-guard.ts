import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { resolveLocalRegion } from '../services/region-resolver.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    migrationGuard?: boolean;
  }
}

const STATUS_TTL_SECONDS = 30;
const cacheKey = (appId: string) => `app-status:${appId}`;

const migrationGuardPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('onRequest', async (request, reply) => {
    if (!request.routeOptions.config?.migrationGuard) return;
    const params = request.params as { app_id?: string; appId?: string } | undefined;
    const appId = params?.app_id ?? params?.appId;
    if (!appId) return;
    if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') return;

    let status = await fastify.redis.get(cacheKey(appId));
    if (status === null) {
      const pool = fastify.runtimeDb(resolveLocalRegion());
      const r = await pool.query<{ provisioning_status: string }>(
        `SELECT provisioning_status FROM apps WHERE id = $1`, [appId],
      );
      if (r.rows.length === 0) return;
      status = r.rows[0].provisioning_status;
      await fastify.redis.setex(cacheKey(appId), STATUS_TTL_SECONDS, status);
    }
    if (status === 'migrating') {
      reply.header('Retry-After', '60');
      return reply.code(503).send({
        error: 'app_migrating',
        message: 'This app is being moved to a different region. Writes are temporarily blocked.',
      });
    }
  });
};

export default fp(migrationGuardPlugin, { name: 'migration-guard' });
