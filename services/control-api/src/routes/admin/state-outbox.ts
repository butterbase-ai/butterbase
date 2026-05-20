import type { FastifyPluginAsync } from 'fastify';
import { drainOnce, pruneOldOutboxRows } from '../../services/state-outbox-drain.js';
import { config, assertRegionConfig, assertRuntimeDbConfig } from '../../config.js';
import { getRuntimeDbPool } from '../../services/runtime-db.js';

const stateOutboxRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/v1/internal/state-outbox/drain', async () => {
    assertRuntimeDbConfig();
    const regions = assertRegionConfig().regions;
    const runtimePoolsByRegion: Record<string, ReturnType<typeof getRuntimeDbPool>> = {};
    for (const r of regions) runtimePoolsByRegion[r] = getRuntimeDbPool(config.runtimeDb, r);

    const result = await drainOnce({ platformPool: fastify.controlDb, runtimePoolsByRegion });
    const pruneResult = await pruneOldOutboxRows(fastify.controlDb, 7);
    return { processed: result.processed, errors: result.errors, pruned: pruneResult.deleted };
  });

  fastify.get('/v1/internal/state-outbox/lag', async () => {
    const r = await fastify.controlDb.query<{ pending: number; oldest: string | null }>(
      `SELECT count(*)::int AS pending,
              EXTRACT(EPOCH FROM (now() - min(created_at)))::int AS oldest
       FROM user_state_outbox
       WHERE done_at IS NULL`
    );
    const oldest = r.rows[0].oldest;
    return {
      pending: r.rows[0].pending,
      oldestPendingSeconds: oldest === null ? 0 : parseInt(String(oldest), 10),
    };
  });
};

export default stateOutboxRoutes;
