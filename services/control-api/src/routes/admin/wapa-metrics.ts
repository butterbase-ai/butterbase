import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { requireAdmin } from '../admin-auth.js';

// Activation = first function.invoke OR ai_gateway.invoke (success=true)
// within 7d of auth.signup. Same window as WAPA, so the OKR board stays coherent.
const ACTIVATION_WINDOW_DAYS = 7;
const DEFAULT_WEEKS = 12;
const MAX_WEEKS = 52;

// audit_events.app_id is TEXT NOT NULL. Events that don't belong to an app
// (auth.signup, platform-level gateway calls) use this sentinel.
const PLATFORM_SENTINEL = '_platform';

// Events whose presence proves an app was actively used this week.
// app.create is included so a brand-new app counts as active in its first week
// even before any invocations land.
const WAPA_EVENT_TYPES = ['app.create', 'function.invoke', 'ai_gateway.invoke'];

// Stricter subset: a signup-cohort user is "activated" only when their
// owned app(s) actually serve a request. Creating an app alone is not enough.
const ACTIVATION_EVENT_TYPES = ['function.invoke', 'ai_gateway.invoke'];

function parseBool(v: unknown): boolean {
  return v === '1' || v === 'true' || v === true;
}

function parseWeeks(v: unknown): number {
  const n = parseInt(String(v ?? ''), 10);
  if (isNaN(n) || n <= 0) return DEFAULT_WEEKS;
  return Math.min(n, MAX_WEEKS);
}

const wapaMetricsRoutes = async (app: FastifyInstance) => {
  async function checkAdmin(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
    const userId = await requireAdmin(app, request, reply);
    return userId !== null;
  }

  // ───── GET /admin/metrics/wapa ─────
  // Weekly Active Production Apps over the last N weeks. An app is "active"
  // in week W if any of: app.create, function.invoke (success), ai_gateway.invoke (success)
  // landed in [W, W+7d). Apps owned by @butterbase.ai users excluded when
  // exclude_internal=true.
  app.get('/admin/metrics/wapa', { config: { public: true } }, async (request, reply) => {
    if (!(await checkAdmin(request, reply))) return;
    const q = request.query as Record<string, string | undefined>;
    const weeks = parseWeeks(q.weeks);
    const excludeInternal = parseBool(q.exclude_internal);

    const result = await app.controlDb.query<{ week_start: Date; wapa: number }>(
      `WITH weeks AS (
         SELECT generate_series(
           date_trunc('week', now()) - ($1::int - 1) * interval '7 days',
           date_trunc('week', now()),
           interval '7 days'
         )::date AS week_start
       ),
       active AS (
         SELECT
           date_trunc('week', e.created_at)::date AS week_start,
           e.app_id
         FROM audit_events e
         WHERE e.event_type = ANY($2::text[])
           AND e.success = true
           AND e.app_id <> $3
           AND e.created_at >= date_trunc('week', now()) - ($1::int - 1) * interval '7 days'
           ${excludeInternal ? `
           AND NOT EXISTS (
             SELECT 1 FROM apps a
             JOIN platform_users u ON u.id = a.owner_id
             WHERE a.id = e.app_id AND u.email ILIKE '%@butterbase.ai'
           )` : ''}
         GROUP BY 1, 2
       )
       SELECT w.week_start, coalesce(count(DISTINCT a.app_id), 0)::int AS wapa
       FROM weeks w
       LEFT JOIN active a ON a.week_start = w.week_start
       GROUP BY w.week_start
       ORDER BY w.week_start ASC`,
      [weeks, WAPA_EVENT_TYPES, PLATFORM_SENTINEL]
    );

    return {
      series: result.rows.map(r => ({
        week_start: r.week_start.toISOString().slice(0, 10),
        wapa: r.wapa,
      })),
    };
  });

  // ───── GET /admin/metrics/activation ─────
  // For each signup-cohort week, what fraction of users had any
  // function.invoke or ai_gateway.invoke (success) on an app they own
  // within ACTIVATION_WINDOW_DAYS of signup.
  app.get('/admin/metrics/activation', { config: { public: true } }, async (request, reply) => {
    if (!(await checkAdmin(request, reply))) return;
    const q = request.query as Record<string, string | undefined>;
    const weeks = parseWeeks(q.weeks);
    const excludeInternal = parseBool(q.exclude_internal);

    const result = await app.controlDb.query<{
      cohort_week: Date;
      signups: number;
      activated: number;
    }>(
      `WITH cohort AS (
         SELECT
           u.id AS user_id,
           u.created_at,
           date_trunc('week', u.created_at)::date AS cohort_week
         FROM platform_users u
         WHERE u.created_at >= date_trunc('week', now()) - ($1::int - 1) * interval '7 days'
           AND u.created_at < date_trunc('week', now()) + interval '7 days'
           ${excludeInternal ? `AND u.email NOT ILIKE '%@butterbase.ai'` : ''}
       ),
       activated_users AS (
         SELECT DISTINCT c.user_id
         FROM cohort c
         JOIN apps a ON a.owner_id = c.user_id
         JOIN audit_events e ON e.app_id = a.id
         WHERE e.event_type = ANY($2::text[])
           AND e.success = true
           AND e.created_at >= c.created_at
           AND e.created_at < c.created_at + ($3::int * interval '1 day')
       )
       SELECT
         c.cohort_week,
         count(*)::int AS signups,
         count(au.user_id)::int AS activated
       FROM cohort c
       LEFT JOIN activated_users au ON au.user_id = c.user_id
       GROUP BY c.cohort_week
       ORDER BY c.cohort_week ASC`,
      [weeks, ACTIVATION_EVENT_TYPES, ACTIVATION_WINDOW_DAYS]
    );

    return {
      activation_window_days: ACTIVATION_WINDOW_DAYS,
      series: result.rows.map(r => ({
        cohort_week: r.cohort_week.toISOString().slice(0, 10),
        signups: r.signups,
        activated: r.activated,
        activation_rate: r.signups > 0 ? r.activated / r.signups : 0,
      })),
    };
  });

  // ───── GET /admin/metrics/wapa/breakdown ─────
  // Drill-in: every app active in the given week, with its last event type,
  // owner email, and signup source.
  app.get('/admin/metrics/wapa/breakdown', { config: { public: true } }, async (request, reply) => {
    if (!(await checkAdmin(request, reply))) return;
    const q = request.query as Record<string, string | undefined>;
    const week = q.week; // YYYY-MM-DD (Monday of the target week)
    const excludeInternal = parseBool(q.exclude_internal);

    if (!week || !/^\d{4}-\d{2}-\d{2}$/.test(week)) {
      return reply.code(400).send({ error: 'week query param required (YYYY-MM-DD)' });
    }

    const result = await app.controlDb.query<{
      app_id: string;
      app_name: string | null;
      owner_email: string | null;
      signup_source: string | null;
      last_event_type: string;
      last_event_at: Date;
      event_count: number;
    }>(
      `WITH window AS (
         SELECT date_trunc('week', $1::date)::date AS week_start
       ),
       in_window AS (
         SELECT e.app_id, e.event_type, e.created_at
         FROM audit_events e, window w
         WHERE e.event_type = ANY($2::text[])
           AND e.success = true
           AND e.app_id <> $3
           AND e.created_at >= w.week_start
           AND e.created_at <  w.week_start + interval '7 days'
       ),
       ranked AS (
         SELECT
           app_id,
           event_type,
           created_at,
           count(*) OVER (PARTITION BY app_id) AS event_count,
           row_number() OVER (PARTITION BY app_id ORDER BY created_at DESC) AS rn
         FROM in_window
       )
       SELECT
         r.app_id,
         a.name AS app_name,
         u.email AS owner_email,
         u.signup_source,
         r.event_type AS last_event_type,
         r.created_at AS last_event_at,
         r.event_count::int AS event_count
       FROM ranked r
       LEFT JOIN apps a ON a.id = r.app_id
       LEFT JOIN platform_users u ON u.id = a.owner_id
       WHERE r.rn = 1
         ${excludeInternal ? `AND (u.email IS NULL OR u.email NOT ILIKE '%@butterbase.ai')` : ''}
       ORDER BY r.event_count DESC, r.created_at DESC
       LIMIT 500`,
      [week, WAPA_EVENT_TYPES, PLATFORM_SENTINEL]
    );

    return {
      week_start: week,
      apps: result.rows.map(r => ({
        app_id: r.app_id,
        app_name: r.app_name,
        owner_email: r.owner_email,
        signup_source: r.signup_source,
        last_event_type: r.last_event_type,
        last_event_at: r.last_event_at.toISOString(),
        event_count: r.event_count,
      })),
    };
  });
};

export default wapaMetricsRoutes;
