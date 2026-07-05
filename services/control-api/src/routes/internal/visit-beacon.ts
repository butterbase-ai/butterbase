import type { FastifyPluginAsync } from 'fastify';

interface VisitBeaconBody {
  app_id: string;
  count: number;
  unique_hashes: string[];
}

/**
 * Called by the edge dispatch worker every N seconds (or every ~200 requests)
 * with a batch of visits for a single app. We upsert today's row in
 * frontend_visit_daily, accumulating request_count and unique_visitor_count.
 *
 * `unique_visitor_count` is an approximation: dedupe happens per-batch, not
 * per-day. Multiple visits by the same IP+UA in different batches count as
 * distinct uniques. This is a known trade-off — precise dedupe would require
 * a per-day HLL or set, which is out of scope.
 *
 * Auth is enforced by the internal-auth plugin (routes/plugins/internal-auth.ts)
 * for every URL under /v1/internal/.
 */
const visitBeaconRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: VisitBeaconBody }>(
    '/v1/internal/visit-beacon',
    {
      schema: {
        body: {
          type: 'object',
          required: ['app_id', 'count', 'unique_hashes'],
          properties: {
            app_id: { type: 'string', minLength: 1 },
            count: { type: 'integer', minimum: 0 },
            unique_hashes: {
              type: 'array',
              maxItems: 10000,
              items: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { app_id, count, unique_hashes } = request.body;
      const uniqueCount = new Set(unique_hashes).size;

      await fastify.controlDb.query(
        `INSERT INTO frontend_visit_daily(app_id, day, request_count, unique_visitor_count)
           SELECT $1, CURRENT_DATE, $2, $3
           WHERE EXISTS (SELECT 1 FROM org_app_index WHERE app_id = $1)
           ON CONFLICT (app_id, day) DO UPDATE
           SET request_count = frontend_visit_daily.request_count + EXCLUDED.request_count,
               unique_visitor_count = frontend_visit_daily.unique_visitor_count + EXCLUDED.unique_visitor_count`,
        [app_id, count, uniqueCount]
      );

      return reply.code(204).send();
    }
  );
};

export default visitBeaconRoutes;
