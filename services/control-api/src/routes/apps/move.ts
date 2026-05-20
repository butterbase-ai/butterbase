import type { FastifyPluginAsync } from 'fastify';
import { checkMoveAppEligibility } from '../../services/move-app/eligibility.js';
import { createMigration, getMigration, markAborted } from '../../services/move-app/migration-store.js';
import { requireUserId } from '../../utils/require-auth.js';

const HAPPY_PATH = [
  'requested',
  'reserving_dest',
  'blocking_writes',
  'dumping_data',
  'restoring_data',
  'copying_blobs',
  'copying_runtime',
  'flipping_routing',
  'setting_up_reverse_replication',
  'unblocking_writes',
  'completed',
];

const HAPPY_PATH_INDEX_OF = (step: string): number => HAPPY_PATH.indexOf(step);

const moveAppRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Params: { app_id: string }; Body: { dest_region: string } }>(
    '/v1/apps/:app_id/move',
    async (request, reply) => {
      const { app_id } = request.params;
      const { dest_region } = request.body ?? ({} as any);
      if (!dest_region) return reply.code(400).send({ error: 'dest_region required' });

      const eligible = await checkMoveAppEligibility(fastify.controlDb, app_id, dest_region);
      if (!eligible.ok) return reply.code(409).send({ error: 'ineligible', reason: eligible.reason });

      const ownerId = requireUserId(request);

      const ix = await fastify.controlDb.query<{ region: string }>(
        `SELECT region FROM user_app_index WHERE app_id = $1`,
        [app_id],
      );
      if (ix.rows.length === 0) return reply.code(404).send({ error: 'app not found' });

      const id = await createMigration(fastify.controlDb, {
        appId: app_id,
        userId: ownerId,
        sourceRegion: ix.rows[0].region,
        destRegion: dest_region,
      });
      return reply.code(202).send({ migration_id: id, status: 'queued' });
    },
  );

  fastify.get<{ Params: { app_id: string; migration_id: string } }>(
    '/v1/apps/:app_id/migrations/:migration_id',
    async (request, reply) => {
      const m = await getMigration(fastify.controlDb, request.params.migration_id);
      if (!m || m.app_id !== request.params.app_id) {
        return reply.code(404).send({ error: 'not found' });
      }
      return {
        migration_id: m.id,
        current_step: m.current_step,
        last_error: m.last_error,
        retry_count: m.retry_count,
        source_region: m.source_region,
        dest_region: m.dest_region,
        source_replica_state: m.source_replica_state,
        step_started_at: m.step_started_at,
        completed_at: m.completed_at,
        progress: m.dest_resources,
      };
    },
  );

  fastify.get<{ Params: { app_id: string } }>(
    '/v1/apps/:app_id/migrations/active',
    async (request, reply) => {
      const userId = requireUserId(request);
      const r = await fastify.controlDb.query(
        `SELECT id, current_step, source_region, dest_region, source_replica_state, step_started_at
         FROM app_migrations
         WHERE app_id = $1 AND user_id = $2 AND current_step NOT IN ('completed','aborted','failed')
         ORDER BY initiated_at DESC LIMIT 1`,
        [request.params.app_id, userId],
      );
      return { migration: r.rows[0] ?? null };
    },
  );

  fastify.post<{ Params: { app_id: string; migration_id: string } }>(
    '/v1/apps/:app_id/migrations/:migration_id/abort',
    async (request, reply) => {
      const m = await getMigration(fastify.controlDb, request.params.migration_id);
      if (!m || m.app_id !== request.params.app_id) return reply.code(404).send({ error: 'not found' });
      if (m.current_step === 'completed') {
        return reply.code(409).send({ error: 'cannot abort completed migration; use reverse-move' });
      }
      const flipIdx = HAPPY_PATH_INDEX_OF('flipping_routing');
      if (HAPPY_PATH_INDEX_OF(m.current_step) >= flipIdx) {
        return reply.code(409).send({ error: 'cannot abort after cutover; use reverse-move' });
      }
      await markAborted(fastify.controlDb, m.id, 'user_requested');
      return { migration_id: m.id, status: 'aborted' };
    },
  );
};

export default moveAppRoutes;
