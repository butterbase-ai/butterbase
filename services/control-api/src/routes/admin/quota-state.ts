import type { FastifyPluginAsync } from 'fastify';

const quotaStateRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/v1/internal/quota-state', async () => {
    const [outbox, leases, reclaim] = await Promise.all([
      fastify.controlDb.query<{ pending: number; oldest: string | null }>(
        `SELECT count(*)::int AS pending,
                EXTRACT(EPOCH FROM (now() - min(created_at)))::int AS oldest
         FROM user_state_outbox WHERE done_at IS NULL`
      ),
      fastify.controlDb.query<{ active_count: number; total_usd: string | null }>(
        `SELECT count(*)::int AS active_count, COALESCE(sum(amount_usd), 0)::text AS total_usd
         FROM credit_leases WHERE status = 'active'`
      ),
      fastify.controlDb.query<{ count_24h: number; total_24h: string | null }>(
        `SELECT count(*)::int AS count_24h, COALESCE(sum(amount_usd), 0)::text AS total_24h
         FROM credit_leases
         WHERE status = 'reclaimed' AND reclaimed_at > now() - interval '24 hours'`
      ),
    ]);
    return {
      outbox: {
        pending: outbox.rows[0].pending,
        oldestPendingSeconds: outbox.rows[0].oldest === null ? 0 : parseInt(String(outbox.rows[0].oldest), 10),
      },
      leases: {
        activeCount: leases.rows[0].active_count,
        totalActiveUsd: parseFloat(leases.rows[0].total_usd ?? '0'),
      },
      reclaim: {
        reclaimedLast24h: reclaim.rows[0].count_24h,
        reclaimedTotalUsd24h: parseFloat(reclaim.rows[0].total_24h ?? '0'),
      },
    };
  });
};

export default quotaStateRoutes;
