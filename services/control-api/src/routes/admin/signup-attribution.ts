import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { requireAdmin } from '../admin-auth.js';

// GET /admin/metrics/signup-attribution
//
// Aggregates platform_users.signup_source / signup_referrer for the marketing
// dashboard. Ranges: '30d' (default) or 'all'. Excludes internal emails by
// default (@butterbase.ai).
//
// Response shape is stable; consumers depend on it. Keep changes additive.

const INTERNAL_EMAIL_SUFFIX = '@butterbase.ai';
const RECENT_LIMIT = 100;
const TOP_N = 20;

type Range = '30d' | 'all';

function parseBool(v: unknown): boolean {
  return v === '1' || v === 'true' || v === true;
}

function parseRange(v: unknown): Range {
  return v === 'all' ? 'all' : '30d';
}

// Return the SQL fragment + bound param for created_at, or null for all-time.
// Kept as a helper so the four queries share one definition.
function rangeClause(range: Range): { where: string; params: unknown[] } {
  if (range === 'all') return { where: '', params: [] };
  return { where: `AND created_at >= now() - interval '30 days'`, params: [] };
}

const signupAttributionRoutes = async (app: FastifyInstance) => {
  async function checkAdmin(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
    const userId = await requireAdmin(app, request, reply);
    return userId !== null;
  }

  app.get(
    '/admin/metrics/signup-attribution',
    { config: { public: true } },
    async (request, reply) => {
      if (!(await checkAdmin(request, reply))) return;

      const q = request.query as Record<string, string | undefined>;
      const range = parseRange(q.range);
      const excludeInternal = parseBool(q.exclude_internal ?? '1');

      const { where: rangeWhere } = rangeClause(range);

      // Internal-exclusion is a WHERE fragment we can inline; no extra param
      // needed since the ILIKE pattern is a static constant.
      const internalWhere = excludeInternal
        ? `AND email NOT ILIKE '%${INTERNAL_EMAIL_SUFFIX}'`
        : '';

      // KPIs — one row.
      const kpisQ = app.controlDb.query<{
        total_signups: string;
        tagged_signups: string;
        with_referrer: string;
      }>(
        `SELECT
           count(*)::text AS total_signups,
           count(*) FILTER (WHERE signup_source IS NOT NULL)::text AS tagged_signups,
           count(*) FILTER (WHERE signup_referrer IS NOT NULL)::text AS with_referrer
         FROM platform_users
         WHERE 1=1 ${rangeWhere} ${internalWhere}`
      );

      // By utm_source. Extract via substring; falls back to '(other)' when the
      // stored string doesn't start with utm_source=... (e.g. a lone
      // source=xyz alias, or a raw non-UTM value).
      const bySourceQ = app.controlDb.query<{ source: string; count: string }>(
        `SELECT
           COALESCE(
             NULLIF(substring(signup_source from 'utm_source=([^&]+)'), ''),
             NULLIF(substring(signup_source from '(?:^|&)source=([^&]+)'), ''),
             '(unparsed)'
           ) AS source,
           count(*)::text AS count
         FROM platform_users
         WHERE signup_source IS NOT NULL ${rangeWhere} ${internalWhere}
         GROUP BY 1
         ORDER BY count(*) DESC
         LIMIT ${TOP_N}`
      );

      // By referrer host. Extract the domain part; strip protocol + path.
      const byReferrerQ = app.controlDb.query<{ domain: string; count: string }>(
        `SELECT
           COALESCE(
             NULLIF(substring(signup_referrer from 'https?://([^/]+)'), ''),
             signup_referrer
           ) AS domain,
           count(*)::text AS count
         FROM platform_users
         WHERE signup_referrer IS NOT NULL ${rangeWhere} ${internalWhere}
         GROUP BY 1
         ORDER BY count(*) DESC
         LIMIT ${TOP_N}`
      );

      // Recent tagged signups — the audit-trail table on the page.
      const recentQ = app.controlDb.query<{
        id: string;
        email: string;
        plan_id: string | null;
        created_at: Date;
        signup_source: string | null;
        signup_referrer: string | null;
      }>(
        `SELECT pu.id, pu.email, o.plan_id, pu.created_at,
                pu.signup_source, pu.signup_referrer
         FROM platform_users pu
         LEFT JOIN organizations o ON o.id = pu.personal_organization_id
         WHERE (pu.signup_source IS NOT NULL OR pu.signup_referrer IS NOT NULL)
           ${rangeWhere.replace(/created_at/g, 'pu.created_at')}
           ${excludeInternal ? `AND pu.email NOT ILIKE '%${INTERNAL_EMAIL_SUFFIX}'` : ''}
         ORDER BY pu.created_at DESC
         LIMIT ${RECENT_LIMIT}`
      );

      const [kpisRes, bySourceRes, byReferrerRes, recentRes] = await Promise.all([
        kpisQ,
        bySourceQ,
        byReferrerQ,
        recentQ,
      ]);

      const kpis = kpisRes.rows[0];
      const total = parseInt(kpis?.total_signups ?? '0', 10);
      const tagged = parseInt(kpis?.tagged_signups ?? '0', 10);
      const withReferrer = parseInt(kpis?.with_referrer ?? '0', 10);

      return {
        range,
        exclude_internal: excludeInternal,
        kpis: {
          total_signups: total,
          tagged_signups: tagged,
          with_referrer: withReferrer,
          coverage_pct: total > 0 ? tagged / total : 0,
        },
        by_source: bySourceRes.rows.map((r) => ({
          source: r.source,
          count: parseInt(r.count, 10),
        })),
        by_referrer: byReferrerRes.rows.map((r) => ({
          domain: r.domain,
          count: parseInt(r.count, 10),
        })),
        recent: recentRes.rows.map((r) => ({
          id: r.id,
          email: r.email,
          plan_id: r.plan_id,
          created_at: r.created_at,
          signup_source: r.signup_source,
          signup_referrer: r.signup_referrer,
        })),
      };
    }
  );
};

export default signupAttributionRoutes;
