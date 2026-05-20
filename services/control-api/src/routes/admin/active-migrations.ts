import type { FastifyPluginAsync } from 'fastify';

const activeMigrationsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/v1/internal/active-migrations', async () => {
    const byStep = await fastify.controlDb.query<{ current_step: string; c: number; oldest: Date }>(
      `SELECT current_step, count(*)::int AS c, min(step_started_at) AS oldest
       FROM app_migrations
       WHERE current_step NOT IN ('completed','aborted','failed')
       GROUP BY current_step`,
    );
    const byRegion = await fastify.controlDb.query<{ region_pair: string; c: number }>(
      `SELECT (source_region || ' → ' || dest_region) AS region_pair, count(*)::int AS c
       FROM app_migrations
       WHERE current_step NOT IN ('completed','aborted','failed')
       GROUP BY 1`,
    );
    const replicas = await fastify.controlDb.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM app_migrations WHERE source_replica_state = 'replicating'`,
    );
    return {
      by_step: byStep.rows,
      by_region_pair: byRegion.rows,
      active_source_replicas: replicas.rows[0].c,
    };
  });
};

export default activeMigrationsRoutes;
