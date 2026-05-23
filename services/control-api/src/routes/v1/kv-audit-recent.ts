import type { FastifyPluginAsync } from 'fastify';
import { resolveKvAuth } from '../../services/kv/auth.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

interface AuditEntry {
  at: string;
  method: string;
  path: string;
  status_code: number;
  error_code: string | null;
  key: string | null;
}

const kvAuditRecentRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{
    Params: { app_id: string };
    Querystring: { limit?: string };
  }>('/v1/:app_id/kv/_audit_recent', async (req, reply) => {
    const { app_id: appId } = req.params;
    const auth = await resolveKvAuth(fastify.controlDb, appId, req);
    if ('error' in auth) return reply.code(auth.status).send(auth.body);

    const rawLimit = parseInt(req.query.limit ?? String(DEFAULT_LIMIT), 10);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(MAX_LIMIT, rawLimit)) : DEFAULT_LIMIT;

    const r = await fastify.controlDb.query<{
      at: Date;
      method: string;
      path: string;
      status_code: number;
      error_code: string | null;
    }>(
      `SELECT at, method, path, status_code, error_code
         FROM audit_logs
        WHERE app_id = $1
          AND path LIKE $2
          AND status_code >= 400
        ORDER BY at DESC
        LIMIT $3`,
      [appId, `/v1/${appId}/kv/%`, limit],
    );

    const entries: AuditEntry[] = r.rows.map((row) => {
      const prefix = `/v1/${appId}/kv/`;
      const tail = row.path.startsWith(prefix) ? row.path.slice(prefix.length) : null;
      const key = tail && !tail.startsWith('_') ? tail.split('/')[0] || null : null;
      return {
        at: row.at.toISOString(),
        method: row.method,
        path: row.path,
        status_code: row.status_code,
        error_code: row.error_code,
        key,
      };
    });

    return { entries };
  });
};

export default kvAuditRecentRoutes;
