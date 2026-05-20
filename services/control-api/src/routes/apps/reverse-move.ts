import type { FastifyPluginAsync } from 'fastify';
import { runReverseMove } from '../../services/move-app/reverse-move.js';
import { requireUserId } from '../../utils/require-auth.js';

const reverseMoveRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Params: { app_id: string; migration_id: string } }>(
    '/v1/apps/:app_id/migrations/:migration_id/reverse',
    async (request, reply) => {
      const userId = requireUserId(request);
      try {
        const r = await runReverseMove((fastify as any).moveAppCtx, {
          forwardMigrationId: request.params.migration_id,
          userId,
        });
        return reply.code(202).send({ migrationId: r.migrationId, path: r.path });
      } catch (e: any) {
        return reply.code(409).send({ error: 'reverse_move_failed', reason: e.message });
      }
    },
  );
};

export default reverseMoveRoutes;
