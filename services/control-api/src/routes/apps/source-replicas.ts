import type { FastifyPluginAsync } from 'fastify';
import { listActiveSourceReplicas, teardownSourceReplica } from '../../services/move-app/source-retention.js';
import { requireUserId } from '../../utils/require-auth.js';

const sourceReplicaRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/v1/source-replicas', async (request, reply) => {
    const userId = requireUserId(request);
    const list = await listActiveSourceReplicas(fastify.controlDb, userId);
    return { source_replicas: list };
  });

  fastify.delete<{ Params: { migration_id: string } }>(
    '/v1/source-replicas/:migration_id',
    async (request, reply) => {
      const userId = requireUserId(request);
      const { rows } = await fastify.controlDb.query(
        `SELECT 1 FROM app_migrations WHERE id = $1 AND user_id = $2`,
        [request.params.migration_id, userId],
      );
      if (rows.length === 0) return reply.code(404).send({ error: 'not found' });
      try {
        await teardownSourceReplica({
          controlPool: fastify.controlDb,
          enqueueDeprovision: (fastify as any).moveAppCtx.enqueueDeprovision,
        }, request.params.migration_id);
        return { status: 'torn_down' };
      } catch (e: any) {
        return reply.code(409).send({ error: 'teardown_failed', reason: e.message });
      }
    },
  );
};

export default sourceReplicaRoutes;
