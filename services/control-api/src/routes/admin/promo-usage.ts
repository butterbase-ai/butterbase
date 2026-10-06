import type { FastifyInstance } from 'fastify';
import { requireAdmin } from '../admin-auth.js';
import { fanOutQuery } from '../../services/region-resolver.js';

// GET /admin/metrics/promo-usage?days=30
//
// Did the people we acquired from a given channel actually use the Qwen promo?
//
// This is a cross-plane question and there is no way around the two hops:
// signup_source lives on platform_users in the CONTROL plane, while
// ai_usage_logs lives in the regional RUNTIME planes (dropped from the control
// plane in 061_post_cutover_drop_runtime_tables.sql). So we fan out for the
// user ids, then resolve their sources centrally.
//
// HOW COVERAGE IS IDENTIFIED — read this before trusting the numbers.
// `promo_covered` is NOT a column. router.ts emits it on the structured log
// line only; what reaches the database is charged_to_user = false with
// charged_credits_usd = 0. So coverage is inferred from the triple
// (router, charged_to_user, key_type) rather than read directly. The proxy is
// deliberate: it works retroactively over rows already written, whereas a real
// column would only count calls made after it shipped. It is slightly fuzzy —
// any other uncharged platform-key path on the same router would also match.
// If this ever needs to be exact, add the column and switch this query; the
// response shape does not have to change.

const PROMO_ROUTER = 'provider-quaternary';
const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;

function parseDays(v: unknown): number {
  const n = typeof v === 'string' ? parseInt(v, 10) : NaN;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_DAYS;
  return Math.min(n, MAX_DAYS);
}

const promoUsageRoutes = async (app: FastifyInstance) => {
  app.get('/admin/metrics/promo-usage', { config: { public: true } }, async (request, reply) => {
    const adminId = await requireAdmin(app, request, reply);
    if (!adminId) return;

    const q = request.query as Record<string, string | undefined>;
    const days = parseDays(q.days);

    // Hop 1 — every user who had a promo-covered call served, across regions.
    // DISTINCT per region; the same user cannot appear in two regions for one
    // app, but we de-duplicate in JS anyway rather than rely on that.
    const rows = await fanOutQuery<{ user_id: string | null }>(
      `SELECT DISTINCT user_id
         FROM ai_usage_logs
        WHERE router = $1
          AND charged_to_user = false
          AND key_type = 'platform'
          AND user_id IS NOT NULL
          AND created_at >= now() - ($2 || ' days')::interval`,
      [PROMO_ROUTER, String(days)],
    );

    const userIds = [...new Set(rows.map((r) => r.user_id).filter((id): id is string => !!id))];

    if (userIds.length === 0) {
      // Short-circuit: `id = ANY('{}')` is valid but pointless, and an empty
      // report is a real answer (nobody used the promo), not an error.
      return { days, promo_users: 0, by_source: [] };
    }

    // Hop 2 — resolve those ids to signup sources. Users with no source at all
    // (every MCP signup before the consent redirect was tagged, for one) group
    // under '(untagged)' so the rows still sum to promo_users.
    const bySource = await app.controlDb.query<{ source: string; users: string }>(
      `SELECT
         COALESCE(
           NULLIF(substring(signup_source from 'utm_source=([^&]+)'), ''),
           NULLIF(substring(signup_source from '(?:^|&)source=([^&]+)'), ''),
           '(untagged)'
         ) AS source,
         count(*)::text AS users
       FROM platform_users
       WHERE id = ANY($1)
       GROUP BY 1
       ORDER BY count(*) DESC`,
      [userIds],
    );

    return {
      days,
      promo_users: userIds.length,
      by_source: bySource.rows.map((r) => ({
        source: r.source,
        users: parseInt(r.users, 10),
      })),
    };
  });
};

export default promoUsageRoutes;
