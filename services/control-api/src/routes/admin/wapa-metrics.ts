import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { requireAdmin } from '../admin-auth.js';
import { fanOutQuery } from '../../services/region-resolver.js';

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

const INTERNAL_EMAIL_SUFFIX = '@butterbase.ai';

function parseBool(v: unknown): boolean {
  return v === '1' || v === 'true' || v === true;
}

function parseWeeks(v: unknown): number {
  const n = parseInt(String(v ?? ''), 10);
  if (isNaN(n) || n <= 0) return DEFAULT_WEEKS;
  return Math.min(n, MAX_WEEKS);
}

// Architecture note: audit_events lives on control-plane, but `apps` is
// runtime-plane (per-region). Internal-exclusion + cohort-by-owner cannot be
// done in a single SQL join; we fan out for apps and intersect in TS.

async function fetchInternalAppIds(controlDb: import('pg').Pool): Promise<Set<string>> {
  const internalUsers = await controlDb.query<{ id: string }>(
    `SELECT id FROM platform_users WHERE email ILIKE $1`,
    [`%${INTERNAL_EMAIL_SUFFIX}`]
  );
  if (internalUsers.rows.length === 0) return new Set();
  const internalUserIds = internalUsers.rows.map(r => r.id);
  const apps = await fanOutQuery<{ id: string }>(
    `SELECT id FROM apps WHERE owner_id = ANY($1::uuid[])`,
    [internalUserIds]
  );
  return new Set(apps.map(a => a.id));
}

const wapaMetricsRoutes = async (app: FastifyInstance) => {
  async function checkAdmin(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
    const userId = await requireAdmin(app, request, reply);
    return userId !== null;
  }

  // ───── GET /admin/metrics/wapa ─────
  app.get('/admin/metrics/wapa', { config: { public: true } }, async (request, reply) => {
    if (!(await checkAdmin(request, reply))) return;
    const q = request.query as Record<string, string | undefined>;
    const weeks = parseWeeks(q.weeks);
    const excludeInternal = parseBool(q.exclude_internal);

    const [rows, internalAppIds] = await Promise.all([
      app.controlDb.query<{ week_start: Date; app_id: string }>(
        `SELECT DISTINCT
           date_trunc('week', e.created_at)::date AS week_start,
           e.app_id
         FROM audit_events e
         WHERE e.event_type = ANY($1::text[])
           AND e.success = true
           AND e.app_id <> $2
           AND e.created_at >= date_trunc('week', now()) - ($3::int - 1) * interval '7 days'`,
        [WAPA_EVENT_TYPES, PLATFORM_SENTINEL, weeks]
      ),
      excludeInternal ? fetchInternalAppIds(app.controlDb) : Promise.resolve(new Set<string>()),
    ]);

    // Build the full week grid so empty weeks render as 0.
    const grid = new Map<string, Set<string>>();
    const now = new Date();
    const thisMonday = new Date(Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
    ));
    // date_trunc('week', ...) gives Monday. Mimic that.
    const dow = thisMonday.getUTCDay() === 0 ? 6 : thisMonday.getUTCDay() - 1;
    thisMonday.setUTCDate(thisMonday.getUTCDate() - dow);
    for (let i = weeks - 1; i >= 0; i--) {
      const d = new Date(thisMonday);
      d.setUTCDate(d.getUTCDate() - i * 7);
      grid.set(d.toISOString().slice(0, 10), new Set());
    }

    for (const r of rows.rows) {
      if (internalAppIds.has(r.app_id)) continue;
      const key = r.week_start.toISOString().slice(0, 10);
      const bucket = grid.get(key);
      if (bucket) bucket.add(r.app_id);
    }

    return {
      series: Array.from(grid.entries()).map(([week_start, apps]) => ({
        week_start,
        wapa: apps.size,
      })),
    };
  });

  // ───── GET /admin/metrics/activation ─────
  app.get('/admin/metrics/activation', { config: { public: true } }, async (request, reply) => {
    if (!(await checkAdmin(request, reply))) return;
    const q = request.query as Record<string, string | undefined>;
    const weeks = parseWeeks(q.weeks);
    const excludeInternal = parseBool(q.exclude_internal);

    // 1. Cohort users + their signup-week bucket.
    const cohort = await app.controlDb.query<{
      user_id: string;
      created_at: Date;
      cohort_week: Date;
    }>(
      `SELECT
         id AS user_id,
         created_at,
         date_trunc('week', created_at)::date AS cohort_week
       FROM platform_users
       WHERE created_at >= date_trunc('week', now()) - ($1::int - 1) * interval '7 days'
         AND created_at < date_trunc('week', now()) + interval '7 days'
         ${excludeInternal ? `AND email NOT ILIKE $2` : ''}`,
      excludeInternal ? [weeks, `%${INTERNAL_EMAIL_SUFFIX}`] : [weeks]
    );

    if (cohort.rows.length === 0) {
      return { activation_window_days: ACTIVATION_WINDOW_DAYS, series: [] };
    }

    const userIds = cohort.rows.map(r => r.user_id);

    // 2. Fan out runtime-plane for apps owned by cohort members.
    const apps = await fanOutQuery<{ id: string; owner_id: string }>(
      `SELECT id, owner_id FROM apps WHERE owner_id = ANY($1::uuid[])`,
      [userIds]
    );
    const ownerByApp = new Map<string, string>();
    const appsByOwner = new Map<string, string[]>();
    for (const a of apps) {
      ownerByApp.set(a.id, a.owner_id);
      const list = appsByOwner.get(a.owner_id) ?? [];
      list.push(a.id);
      appsByOwner.set(a.owner_id, list);
    }

    // 3. Events on those apps in the activation window (control-plane).
    const allAppIds = apps.map(a => a.id);
    const events = allAppIds.length === 0
      ? { rows: [] as Array<{ app_id: string; created_at: Date }> }
      : await app.controlDb.query<{ app_id: string; created_at: Date }>(
          `SELECT app_id, created_at
           FROM audit_events
           WHERE event_type = ANY($1::text[])
             AND success = true
             AND app_id = ANY($2::text[])`,
          [ACTIVATION_EVENT_TYPES, allAppIds]
        );

    const earliestEventByOwner = new Map<string, Date>();
    for (const e of events.rows) {
      const ownerId = ownerByApp.get(e.app_id);
      if (!ownerId) continue;
      const prev = earliestEventByOwner.get(ownerId);
      if (!prev || e.created_at < prev) {
        earliestEventByOwner.set(ownerId, e.created_at);
      }
    }

    // 4. Aggregate per cohort_week.
    const buckets = new Map<string, { signups: number; activated: number }>();
    const windowMs = ACTIVATION_WINDOW_DAYS * 86_400_000;
    for (const u of cohort.rows) {
      const key = u.cohort_week.toISOString().slice(0, 10);
      const b = buckets.get(key) ?? { signups: 0, activated: 0 };
      b.signups += 1;
      const earliest = earliestEventByOwner.get(u.user_id);
      if (earliest && earliest.getTime() - u.created_at.getTime() < windowMs) {
        b.activated += 1;
      }
      buckets.set(key, b);
    }

    return {
      activation_window_days: ACTIVATION_WINDOW_DAYS,
      series: Array.from(buckets.entries())
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([cohort_week, v]) => ({
          cohort_week,
          signups: v.signups,
          activated: v.activated,
          activation_rate: v.signups > 0 ? v.activated / v.signups : 0,
        })),
    };
  });

  // ───── GET /admin/metrics/wapa/breakdown ─────
  app.get('/admin/metrics/wapa/breakdown', { config: { public: true } }, async (request, reply) => {
    if (!(await checkAdmin(request, reply))) return;
    const q = request.query as Record<string, string | undefined>;
    const week = q.week;
    const excludeInternal = parseBool(q.exclude_internal);

    if (!week || !/^\d{4}-\d{2}-\d{2}$/.test(week)) {
      return reply.code(400).send({ error: 'week query param required (YYYY-MM-DD)' });
    }

    // 1. Active apps in window from audit_events (control-plane).
    const eventsRes = await app.controlDb.query<{
      app_id: string;
      last_event_type: string;
      last_event_at: Date;
      event_count: number;
    }>(
      `WITH in_window AS (
         SELECT app_id, event_type, created_at
         FROM audit_events
         WHERE event_type = ANY($1::text[])
           AND success = true
           AND app_id <> $2
           AND created_at >= date_trunc('week', $3::date)
           AND created_at <  date_trunc('week', $3::date) + interval '7 days'
       ),
       ranked AS (
         SELECT
           app_id,
           event_type,
           created_at,
           count(*) OVER (PARTITION BY app_id)::int AS event_count,
           row_number() OVER (PARTITION BY app_id ORDER BY created_at DESC) AS rn
         FROM in_window
       )
       SELECT app_id, event_type AS last_event_type, created_at AS last_event_at, event_count
       FROM ranked
       WHERE rn = 1
       ORDER BY event_count DESC, created_at DESC
       LIMIT 500`,
      [WAPA_EVENT_TYPES, PLATFORM_SENTINEL, week]
    );

    if (eventsRes.rows.length === 0) {
      return { week_start: week, apps: [] };
    }

    const appIds = eventsRes.rows.map(r => r.app_id);

    // 2. Fan out runtime-plane for app name + owner.
    const apps = await fanOutQuery<{ id: string; name: string; owner_id: string }>(
      `SELECT id, name, owner_id FROM apps WHERE id = ANY($1::text[])`,
      [appIds]
    );
    const appMeta = new Map(apps.map(a => [a.id, a]));

    // 3. Owner emails + signup_source (control-plane).
    const ownerIds = Array.from(new Set(apps.map(a => a.owner_id)));
    const ownersRes = ownerIds.length === 0
      ? { rows: [] as Array<{ id: string; email: string; signup_source: string | null }> }
      : await app.controlDb.query<{ id: string; email: string; signup_source: string | null }>(
          `SELECT id, email, signup_source FROM platform_users WHERE id = ANY($1::uuid[])`,
          [ownerIds]
        );
    const ownerById = new Map(ownersRes.rows.map(o => [o.id, o]));

    const result = eventsRes.rows
      .map(r => {
        const meta = appMeta.get(r.app_id);
        const owner = meta ? ownerById.get(meta.owner_id) : undefined;
        if (excludeInternal && owner?.email?.toLowerCase().endsWith(INTERNAL_EMAIL_SUFFIX)) {
          return null;
        }
        return {
          app_id: r.app_id,
          app_name: meta?.name ?? null,
          owner_email: owner?.email ?? null,
          signup_source: owner?.signup_source ?? null,
          last_event_type: r.last_event_type,
          last_event_at: r.last_event_at.toISOString(),
          event_count: r.event_count,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    return { week_start: week, apps: result };
  });
};

export default wapaMetricsRoutes;
