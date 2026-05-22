import type { FastifyPluginAsync } from 'fastify';
import { KvCredentialsService } from '../../services/kv-credentials.js';

const kvCredentialsRoutes: FastifyPluginAsync = async (fastify) => {
  const svc = new KvCredentialsService(fastify.controlDb);

  fastify.get<{ Params: { app_id: string } }>(
    '/v1/internal/kv/credentials/:app_id',
    async (req, reply) => {
      const cred = await svc.lookup(req.params.app_id);
      if (!cred) return reply.code(404).send({ error: 'not_found' });
      return {
        app_id: cred.app_id,
        region: cred.region,
        redis_password: cred.redis_password,
      };
    },
  );

  fastify.post<{ Params: { app_id: string } }>(
    '/v1/internal/kv/credentials/:app_id/rotate',
    async (req, reply) => {
      try {
        const cred = await svc.rotate(req.params.app_id);
        return {
          app_id: cred.app_id,
          redis_password: cred.redis_password,
          rotated_at: cred.rotated_at,
        };
      } catch (err) {
        if (err instanceof Error && /No KV credential/.test(err.message)) {
          return reply.code(404).send({ error: 'not_found' });
        }
        throw err;
      }
    },
  );
};

export default kvCredentialsRoutes;
