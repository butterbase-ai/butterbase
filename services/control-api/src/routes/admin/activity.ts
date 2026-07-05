import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { requireAdmin } from '../admin-auth.js';
import { getRuntimeDbForApp, fanOutQuery } from '../../services/region-resolver.js';

function parseIntParam(value: string | undefined, fallback: number, max: number): number {
  const raw = parseInt(value ?? '', 10);
  const n = (isNaN(raw) || raw <= 0) ? fallback : raw;
  return Math.min(n, max);
}

const adminActivityRoutes: FastifyPluginAsync = async (fastify) => {
  async function checkAdmin(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
    const userId = await requireAdmin(fastify, request, reply);
    return userId !== null;
  }

  // ───── GET /admin/activity/overview ─────
  // Platform-wide activity KPIs.
  fastify.get('/admin/activity/overview', { config: { public: true } }, async (request, reply) => {
    if (!(await checkAdmin(request, reply))) return;

    const [activeUsers7d, activeUsers30d, deploysRows, visits7d] = await Promise.all([
      fastify.controlDb.query<{ c: number }>(
        `SELECT count(*)::int AS c FROM platform_users WHERE last_activity_at >= now() - interval '7 days'`,
      ),
      fastify.controlDb.query<{ c: number }>(
        `SELECT count(*)::int AS c FROM platform_users WHERE last_activity_at >= now() - interval '30 days'`,
      ),
      fanOutQuery<{ c: number }>(
        `SELECT count(*)::int AS c FROM apps WHERE last_deployed_at >= now() - interval '7 days'`,
      ),
      fastify.controlDb.query<{ c: number }>(
        `SELECT COALESCE(SUM(request_count), 0)::int AS c FROM frontend_visit_daily WHERE day >= CURRENT_DATE - 6`,
      ),
    ]);

    const deploys_7d = deploysRows.reduce((s, r) => s + r.c, 0);

    return {
      active_platform_users_7d: activeUsers7d.rows[0]?.c ?? 0,
      active_platform_users_30d: activeUsers30d.rows[0]?.c ?? 0,
      deploys_7d,
      total_visits_7d: visits7d.rows[0]?.c ?? 0,
    };
  });

  // ───── GET /admin/activity/platform-users/:id ─────
  // Per-platform-user drill-down.
  fastify.get('/admin/activity/platform-users/:id', { config: { public: true } }, async (request, reply) => {
    if (!(await checkAdmin(request, reply))) return;

    const { id } = request.params as { id: string };

    const [userResult, dailyResult] = await Promise.all([
      fastify.controlDb.query<{ last_login_at: Date | null; last_activity_at: Date | null }>(
        'SELECT last_login_at, last_activity_at FROM platform_users WHERE id = $1',
        [id],
      ),
      fastify.controlDb.query<{ day: Date; action_count: number }>(
        `SELECT day, action_count FROM platform_user_activity_daily
         WHERE user_id = $1 AND day >= CURRENT_DATE - INTERVAL '30 days'
         ORDER BY day DESC`,
        [id],
      ),
    ]);

    if (!userResult.rows[0]) {
      return reply.code(404).send({ error: 'not_found' });
    }

    const user = userResult.rows[0];
    return {
      last_login_at: user.last_login_at?.toISOString() ?? null,
      last_activity_at: user.last_activity_at?.toISOString() ?? null,
      daily: dailyResult.rows.map(r => ({
        day: (r.day instanceof Date ? r.day : new Date(r.day)).toISOString().slice(0, 10),
        action_count: r.action_count,
      })),
    };
  });

  // ───── GET /admin/activity/apps/:id ─────
  // Per-app activity summary (control + runtime DB).
  fastify.get('/admin/activity/apps/:id', { config: { public: true } }, async (request, reply) => {
    if (!(await checkAdmin(request, reply))) return;

    const { id } = request.params as { id: string };

    let runtimePool;
    try {
      runtimePool = await getRuntimeDbForApp(fastify.controlDb, id);
    } catch {
      return reply.code(404).send({ error: 'not_found' });
    }
    const appResult = await runtimePool.query<{ id: string; last_deployed_at: Date | null }>(
      'SELECT id, last_deployed_at FROM apps WHERE id = $1',
      [id],
    );
    if (!appResult.rows[0]) {
      return reply.code(404).send({ error: 'not_found' });
    }
    const appRow = appResult.rows[0];

    const [signups7d, activeUsers7d, visits7d, visits30d, visitDaily] = await Promise.all([
      runtimePool.query<{ c: number }>(
        `SELECT count(*)::int AS c FROM app_users WHERE app_id = $1 AND created_at >= now() - interval '7 days'`,
        [id],
      ),
      runtimePool.query<{ c: number }>(
        `SELECT count(*)::int AS c FROM app_users WHERE app_id = $1 AND last_activity_at >= now() - interval '7 days'`,
        [id],
      ),
      fastify.controlDb.query<{ c: number }>(
        `SELECT COALESCE(SUM(request_count), 0)::int AS c FROM frontend_visit_daily WHERE app_id = $1 AND day >= CURRENT_DATE - 6`,
        [id],
      ),
      fastify.controlDb.query<{ c: number }>(
        `SELECT COALESCE(SUM(request_count), 0)::int AS c FROM frontend_visit_daily WHERE app_id = $1 AND day >= CURRENT_DATE - 29`,
        [id],
      ),
      fastify.controlDb.query<{ day: Date; request_count: number; unique_visitor_count: number }>(
        `SELECT day, request_count, unique_visitor_count FROM frontend_visit_daily
         WHERE app_id = $1 AND day >= CURRENT_DATE - 29
         ORDER BY day DESC`,
        [id],
      ),
    ]);

    return {
      last_deployed_at: appRow.last_deployed_at?.toISOString() ?? null,
      signup_count_7d: signups7d.rows[0]?.c ?? 0,
      active_end_users_7d: activeUsers7d.rows[0]?.c ?? 0,
      visits_7d: visits7d.rows[0]?.c ?? 0,
      visits_30d: visits30d.rows[0]?.c ?? 0,
      visit_daily: visitDaily.rows.map(r => ({
        day: (r.day instanceof Date ? r.day : new Date(r.day)).toISOString().slice(0, 10),
        request_count: r.request_count,
        unique_visitor_count: r.unique_visitor_count,
      })),
    };
  });

  // ───── GET /admin/activity/apps/:id/end-users?limit=N ─────
  // Top-N end-users of an app by 7-day activity.
  fastify.get('/admin/activity/apps/:id/end-users', { config: { public: true } }, async (request, reply) => {
    if (!(await checkAdmin(request, reply))) return;

    const { id } = request.params as { id: string };
    const limit = parseIntParam((request.query as Record<string, string>).limit, 50, 200);

    let runtimePool;
    try {
      runtimePool = await getRuntimeDbForApp(fastify.controlDb, id);
    } catch {
      return reply.code(404).send({ error: 'not_found' });
    }
    const result = await runtimePool.query<{
      app_user_id: string;
      email: string;
      last_sign_in_at: Date | null;
      last_activity_at: Date | null;
      action_count_7d: number;
    }>(
      `SELECT
         u.id AS app_user_id,
         u.email,
         u.last_sign_in_at,
         u.last_activity_at,
         COALESCE(SUM(a.action_count), 0)::int AS action_count_7d
       FROM app_users u
       LEFT JOIN app_user_activity_daily a
         ON a.app_user_id = u.id
         AND a.day >= CURRENT_DATE - INTERVAL '7 days'
       WHERE u.app_id = $1
       GROUP BY u.id, u.email, u.last_sign_in_at, u.last_activity_at
       ORDER BY action_count_7d DESC, u.last_activity_at DESC NULLS LAST
       LIMIT $2`,
      [id, limit],
    );

    return result.rows.map(r => ({
      app_user_id: r.app_user_id,
      email: r.email,
      last_sign_in_at: r.last_sign_in_at?.toISOString() ?? null,
      last_activity_at: r.last_activity_at?.toISOString() ?? null,
      action_count_7d: r.action_count_7d,
    }));
  });

  // ───── GET /admin/activity/recent?limit=N ─────
  // This reads only control-plane audit events (platform_user actor).
  // Cross-region end-user audit events would require fanOutQuery + heap merge — deferred.
  fastify.get('/admin/activity/recent', { config: { public: true } }, async (request, reply) => {
    if (!(await checkAdmin(request, reply))) return;

    const limit = parseIntParam((request.query as Record<string, string>).limit, 100, 500);

    const result = await fastify.controlDb.query<{
      id: string;
      app_id: string | null;
      category: string;
      event_type: string;
      action: string | null;
      actor_type: string;
      actor_id: string | null;
      resource_type: string | null;
      resource_id: string | null;
      success: boolean;
      created_at: Date;
    }>(
      `SELECT id, app_id, category, event_type, action, actor_type, actor_id,
              resource_type, resource_id, success, created_at
       FROM audit_events
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit],
    );

    return result.rows.map(r => ({
      id: r.id,
      app_id: r.app_id,
      category: r.category,
      event_type: r.event_type,
      action: r.action,
      actor_type: r.actor_type,
      actor_id: r.actor_id,
      resource_type: r.resource_type,
      resource_id: r.resource_id,
      success: r.success,
      created_at: r.created_at.toISOString(),
    }));
  });
};

export default adminActivityRoutes;
