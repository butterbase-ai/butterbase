import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { requireAdmin } from './admin-auth.js';
async function getStripeClient(): Promise<any> {
  // Stripe client lives in the cloud overlay; OSS builds reach an explicit failure.
  // @ts-expect-error — overlay path resolved at runtime
  const mod = await import('../../../../cloud-overlays/dist/cloud-overlays/billing/stripe/stripe-service.js');
  return mod.getStripeClient();
}
import {
  fanOutQuery,
  fanOutRuntimeRegions,
  getRuntimeDbForApp,
} from '../services/region-resolver.js';

function parseIntParam(value: string | undefined, fallback: number, max?: number): number {
  const raw = parseInt(value ?? '', 10);
  const n = (isNaN(raw) || raw <= 0) ? fallback : raw;
  return max ? Math.min(n, max) : n;
}

const VALID_PERIODS = ['day', 'week', 'month'] as const;
type Period = (typeof VALID_PERIODS)[number];

function parsePeriodParam(value: string | undefined): Period {
  return (VALID_PERIODS as readonly string[]).includes(value as string)
    ? (value as Period)
    : 'day';
}

function buildOrderBy(
  sortBy: string | undefined,
  sortDir: string | undefined,
  allowed: Record<string, string>,
  defaultOrder: string
): string {
  if (!sortBy || !(sortBy in allowed)) return defaultOrder;
  const dir = (sortDir ?? 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const nulls = dir === 'DESC' ? 'NULLS LAST' : 'NULLS FIRST';
  return `ORDER BY ${allowed[sortBy]} ${dir} ${nulls}`;
}

export async function adminRoutes(app: FastifyInstance) {

  // Helper: check admin auth for all routes
  async function checkAdmin(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
    const userId = await requireAdmin(app, request, reply);
    return userId !== null;
  }

  // ───── GET /admin/overview ─────
  // Returns: platform-wide stats, plan distribution, recent signups, 30-day AI usage
  app.get('/admin/overview', { config: { public: true } }, async (request, reply) => {
    if (!(await checkAdmin(request, reply))) return;

    // Aggregate runtime-tier counts across every configured region (apps,
    // function_invocations, ai_usage_logs are per-region). Platform-tier
    // counts (platform_users, plans) read from the control DB directly.
    const [
      userCount,
      appCountRows,
      fnInvocationsRows,
      aiStatsRows,
      signupsToday,
      signupsWeek,
      activeAppsTodayRows,
      planDist,
      recentSignups,
      aiDailyRows,
    ] = await Promise.all([
      app.controlDb.query(`SELECT count(*)::int AS c FROM platform_users`),
      fanOutQuery<{ c: number }>(`SELECT count(*)::int AS c FROM apps`),
      fanOutQuery<{ c: number }>(`SELECT count(*)::int AS c FROM function_invocations`),
      fanOutQuery<{ requests: number; tokens: string; cost: string }>(
        `SELECT count(*)::int AS requests, coalesce(sum(total_tokens),0)::bigint AS tokens, coalesce(sum(cost_usd),0)::numeric AS cost FROM ai_usage_logs`
      ),
      app.controlDb.query(
        `SELECT count(*)::int AS c FROM platform_users WHERE created_at >= current_date`
      ),
      app.controlDb.query(
        `SELECT count(*)::int AS c FROM platform_users WHERE created_at >= current_date - interval '7 days'`
      ),
      // Distinct app_id is regional (no app appears in two regions), so the
      // sum across regions equals the total distinct count.
      fanOutQuery<{ c: number }>(
        `SELECT count(DISTINCT app_id)::int AS c FROM function_invocations WHERE started_at >= current_date`
      ),
      app.controlDb.query(
        `SELECT plan_id, count(*)::int AS count FROM platform_users GROUP BY plan_id ORDER BY count DESC`
      ),
      app.controlDb.query(
        `SELECT id, email, plan_id, created_at FROM platform_users ORDER BY created_at DESC LIMIT 10`
      ),
      fanOutQuery<{ date: string; requests: number; tokens: string; cost_usd: string }>(
        `SELECT date(created_at) AS date, count(*)::int AS requests,
                coalesce(sum(total_tokens),0)::bigint AS tokens,
                coalesce(sum(cost_usd),0)::numeric AS cost_usd
         FROM ai_usage_logs
         WHERE created_at >= current_date - interval '30 days'
         GROUP BY date(created_at)
         ORDER BY date ASC`
      ),
    ]);

    // Merge daily ai_usage_logs rows by date across regions.
    const aiDailyByDate = new Map<string, { requests: number; tokens: number; cost_usd: number }>();
    for (const r of aiDailyRows) {
      const key = String(r.date);
      const acc = aiDailyByDate.get(key) ?? { requests: 0, tokens: 0, cost_usd: 0 };
      acc.requests += r.requests;
      acc.tokens += Number(r.tokens);
      acc.cost_usd += parseFloat(r.cost_usd);
      aiDailyByDate.set(key, acc);
    }
    const aiDaily = Array.from(aiDailyByDate.entries())
      .map(([date, v]) => ({ date, ...v }))
      .sort((a, b) => (a.date < b.date ? -1 : 1));

    return {
      totalUsers: userCount.rows[0].c,
      totalApps: appCountRows.reduce((acc, r) => acc + r.c, 0),
      totalFunctionInvocations: fnInvocationsRows.reduce((acc, r) => acc + r.c, 0),
      totalAiRequests: aiStatsRows.reduce((acc, r) => acc + r.requests, 0),
      totalAiTokens: aiStatsRows.reduce((acc, r) => acc + Number(r.tokens), 0),
      totalAiCostUsd: aiStatsRows.reduce((acc, r) => acc + parseFloat(r.cost), 0),
      signupsToday: signupsToday.rows[0].c,
      signupsThisWeek: signupsWeek.rows[0].c,
      activeAppsToday: activeAppsTodayRows.reduce((acc, r) => acc + r.c, 0),
      planDistribution: planDist.rows,
      recentSignups: recentSignups.rows,
      aiUsageLast30Days: aiDaily,
    };
  });

  // ───── GET /admin/users ─────
  // Query params: search, plan, status, limit, offset
  // Returns: { data: PlatformUser[], total: number }
  app.get('/admin/users', { config: { public: true } }, async (request, reply) => {
    if (!(await checkAdmin(request, reply))) return;

    const q = request.query as {
      search?: string; plan?: string; status?: string; sub_status?: string; has_apps?: string;
      joined_after?: string; joined_before?: string; has_stripe?: string;
      min_spend?: string; max_spend?: string; min_apps?: string; max_apps?: string;
      sort_by?: string; sort_dir?: string; limit?: string; offset?: string;
      all?: string;
    };
    const exportAll = q.all === '1';
    const limit = parseIntParam(q.limit, 50, 200);
    const offset = parseIntParam(q.offset, 0);

    // note: cross-tier join split for Phase 2 runtime tier
    // FIXME: min_spend, max_spend, min_apps, max_apps, has_apps filters and sort-by runtime
    // columns (ai_cost_usd, ai_tokens, app_count) are applied client-side after fetching
    // platform_users from controlDb and runtime stats from runtimeDb; server-side pagination
    // is approximate when runtime filters are active.

    const controlConditions: string[] = [];
    const controlParams: unknown[] = [];
    let cidx = 1;

    if (q.search) {
      // Match against email, display_name, OR user id (UUID-as-text). The
      // admin UI uses one search box for all three so operators can paste
      // a user id from logs/Stripe metadata without switching context.
      controlConditions.push(
        `(pu.email ILIKE $${cidx} OR pu.display_name ILIKE $${cidx} OR pu.id::text ILIKE $${cidx})`
      );
      controlParams.push(`%${q.search}%`);
      cidx++;
    }
    if (q.plan) {
      controlConditions.push(`pu.plan_id = $${cidx++}`);
      controlParams.push(q.plan);
    }
    if (q.status) {
      controlConditions.push(`pu.account_status = $${cidx++}`);
      controlParams.push(q.status);
    }
    if (q.sub_status) {
      // Subscription status (Stripe-side: active / past_due / canceled / trialing / unpaid /
      // incomplete). EXISTS-filter on the most recent row per user — Stripe can leave behind
      // multiple sub rows after upgrades/downgrades, so we filter on the latest.
      controlConditions.push(
        `EXISTS (
           SELECT 1 FROM subscriptions s
           WHERE s.user_id = pu.id
             AND s.status = $${cidx}
             AND s.created_at = (SELECT max(s2.created_at) FROM subscriptions s2 WHERE s2.user_id = pu.id)
         )`
      );
      controlParams.push(q.sub_status);
      cidx++;
    }

    const isValidDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(new Date(v).getTime());
    if (q.joined_after && isValidDate(q.joined_after)) {
      controlConditions.push(`pu.created_at >= $${cidx++}::date`);
      controlParams.push(q.joined_after);
    }
    if (q.joined_before && isValidDate(q.joined_before)) {
      controlConditions.push(`pu.created_at < ($${cidx++}::date + interval '1 day')`);
      controlParams.push(q.joined_before);
    }
    if (q.has_stripe === 'yes') {
      controlConditions.push(`pu.stripe_customer_id IS NOT NULL`);
    } else if (q.has_stripe === 'no') {
      controlConditions.push(`pu.stripe_customer_id IS NULL`);
    }

    const controlWhere = controlConditions.length > 0 ? `WHERE ${controlConditions.join(' AND ')}` : '';

    // Fetch platform_users from controlDb (platform tier)
    const usersResult = await app.controlDb.query(
      `SELECT pu.id, pu.email, pu.display_name, pu.plan_id, pu.account_status,
              pu.stripe_customer_id, pu.created_at
       FROM platform_users pu
       ${controlWhere}
       ORDER BY pu.created_at DESC`,
      controlParams
    );

    const userRows: any[] = usersResult.rows;
    if (userRows.length === 0) {
      return { data: [], total: 0 };
    }

    const userIds: string[] = userRows.map((r: any) => r.id);

    // Fetch runtime stats from every region and sum per-user. Per-region
    // rows are mutually disjoint (no app appears in two regions), so this
    // is a true cross-region aggregate.
    const runtimeStatsRows = await fanOutQuery<{
      owner_id: string; app_count: number; ai_cost_usd: string; ai_tokens: string;
    }>(
      `SELECT a.owner_id,
              count(DISTINCT a.id)::int AS app_count,
              coalesce(sum(u.cost_usd), 0)::numeric AS ai_cost_usd,
              coalesce(sum(u.total_tokens), 0)::bigint AS ai_tokens
       FROM apps a
       LEFT JOIN ai_usage_logs u ON u.app_id = a.id
       WHERE a.owner_id = ANY($1::uuid[])
       GROUP BY a.owner_id`,
      [userIds]
    );

    const runtimeByUser = new Map<string, { app_count: number; ai_cost_usd: number; ai_tokens: number }>();
    for (const r of runtimeStatsRows) {
      const acc = runtimeByUser.get(r.owner_id) ?? { app_count: 0, ai_cost_usd: 0, ai_tokens: 0 };
      acc.app_count += r.app_count;
      acc.ai_cost_usd += parseFloat(r.ai_cost_usd);
      acc.ai_tokens += Number(r.ai_tokens);
      runtimeByUser.set(r.owner_id, acc);
    }

    // Merge
    let merged = userRows.map((r: any) => {
      const rt = runtimeByUser.get(r.id) ?? { app_count: 0, ai_cost_usd: 0, ai_tokens: 0 };
      return { ...r, ...rt };
    });

    // Apply runtime-side filters client-side
    const minSpend = parseFloat(q.min_spend ?? '');
    if (!isNaN(minSpend) && minSpend >= 0) {
      merged = merged.filter((r: any) => r.ai_cost_usd >= minSpend);
    }
    const maxSpend = parseFloat(q.max_spend ?? '');
    if (!isNaN(maxSpend) && maxSpend >= 0) {
      merged = merged.filter((r: any) => r.ai_cost_usd <= maxSpend);
    }
    const minApps = parseInt(q.min_apps ?? '', 10);
    if (!isNaN(minApps) && minApps >= 0) {
      merged = merged.filter((r: any) => r.app_count >= minApps);
    }
    const maxApps = parseInt(q.max_apps ?? '', 10);
    if (!isNaN(maxApps) && maxApps >= 0) {
      merged = merged.filter((r: any) => r.app_count <= maxApps);
    }
    if (q.has_apps === 'has') {
      merged = merged.filter((r: any) => r.app_count > 0);
    } else if (q.has_apps === 'none') {
      merged = merged.filter((r: any) => r.app_count === 0);
    }

    // Apply sort client-side for runtime columns
    const sortDir = (q.sort_dir ?? 'desc').toLowerCase() === 'asc' ? 1 : -1;
    if (q.sort_by === 'ai_cost_usd') {
      merged.sort((a: any, b: any) => sortDir * (a.ai_cost_usd - b.ai_cost_usd));
    } else if (q.sort_by === 'ai_tokens') {
      merged.sort((a: any, b: any) => sortDir * (a.ai_tokens - b.ai_tokens));
    } else if (q.sort_by === 'app_count') {
      merged.sort((a: any, b: any) => sortDir * (a.app_count - b.app_count));
    } else if (q.sort_by === 'email') {
      merged.sort((a: any, b: any) => sortDir * a.email.localeCompare(b.email));
    }
    // default: already sorted by created_at DESC from controlDb query

    const total = merged.length;

    const data = exportAll ? merged : merged.slice(offset, offset + limit);

    return { data, total };
  });

  // ───── GET /admin/apps ─────
  // Query params: search, limit, offset
  // Returns: { data: AppRow[], total: number }
  app.get('/admin/apps', { config: { public: true } }, async (request, reply) => {
    if (!(await checkAdmin(request, reply))) return;

    const q = request.query as {
      search?: string; region?: string; db_status?: string;
      sort_by?: string; sort_dir?: string; limit?: string; offset?: string;
    };
    const limit = parseIntParam(q.limit, 50, 200);
    const offset = parseIntParam(q.offset, 0);

    // Cross-region admin list: query each runtime DB independently for
    // matching rows (each region's apps table is disjoint), merge in JS,
    // sort, then slice for pagination. We over-fetch per region (capped at
    // limit+offset, max 1000) so the merged page is stable for typical
    // dashboard pagination.

    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (q.search) {
      conditions.push(`(a.name ILIKE $${idx} OR a.id ILIKE $${idx})`);
      params.push(`%${q.search}%`);
      idx++;
    }
    if (q.region) {
      conditions.push(`a.region = $${idx++}`);
      params.push(q.region);
    }
    if (q.db_status === 'ready') {
      conditions.push(`a.db_provisioned = true`);
    } else if (q.db_status === 'pending') {
      conditions.push(`a.db_provisioned = false`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const orderBy = buildOrderBy(q.sort_by, q.sort_dir, {
      created_at: 'a.created_at',
      last_deployed_at: 'a.last_deployed_at',
      function_count: 'function_count',
      name: 'a.name',
    }, 'ORDER BY a.created_at DESC');

    const fetchCap = Math.min(limit + offset, 1000);

    const allRowsByRegion = await fanOutRuntimeRegions(async (pool) => {
      const [d, c] = await Promise.all([
        pool.query<any>(
          `SELECT a.id, a.name, a.region, a.db_provisioned, a.deployment_url,
                  a.last_deployed_at, a.created_at, a.owner_id,
                  coalesce(fc.fn_count, 0)::int AS function_count
           FROM apps a
           LEFT JOIN LATERAL (
             SELECT count(*) AS fn_count FROM app_functions WHERE app_id = a.id AND deleted_at IS NULL
           ) fc ON true
           ${where}
           ${orderBy}
           LIMIT $${idx}`,
          [...params, fetchCap]
        ),
        pool.query<{ total: number }>(
          `SELECT count(*)::int AS total FROM apps a ${where}`,
          params
        ),
      ]);
      return { rows: d.rows, total: c.rows[0].total };
    });

    const mergedRows = allRowsByRegion.flatMap((r) => r.result.rows);
    const totalCount = allRowsByRegion.reduce((acc, r) => acc + r.result.total, 0);

    // Re-apply the chosen ordering in JS, since the per-region SQL ORDER BY
    // returns rows in each region's own order — merging needs a global sort.
    const sortDir = (q.sort_dir ?? 'desc').toLowerCase() === 'asc' ? 1 : -1;
    const validSortKeys: Record<string, string> = {
      created_at: 'created_at',
      last_deployed_at: 'last_deployed_at',
      function_count: 'function_count',
      name: 'name',
    };
    const cmpKey = validSortKeys[q.sort_by ?? 'created_at'] ?? 'created_at';
    mergedRows.sort((a: any, b: any) => {
      const av = a[cmpKey];
      const bv = b[cmpKey];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return av < bv ? -sortDir : av > bv ? sortDir : 0;
    });

    const page = mergedRows.slice(offset, offset + limit);

    // Enrich with owner_email from controlDb (platform tier)
    const ownerIds: string[] = [...new Set(page.map((r: any) => r.owner_id))];
    const ownerEmailMap = new Map<string, string>();
    if (ownerIds.length > 0) {
      const ownersResult = await app.controlDb.query(
        `SELECT id, email FROM platform_users WHERE id = ANY($1::uuid[])`,
        [ownerIds]
      );
      for (const r of ownersResult.rows) {
        ownerEmailMap.set(r.id, r.email);
      }
    }

    return {
      data: page.map((r: any) => ({
        ...r,
        owner_email: ownerEmailMap.get(r.owner_id) ?? null,
      })),
      total: totalCount,
    };
  });

  // ───── GET /admin/ai-usage ─────
  // Query params: days (default 30, max 90)
  // Returns: AiUsageSummary
  app.get('/admin/ai-usage', { config: { public: true } }, async (request, reply) => {
    if (!(await checkAdmin(request, reply))) return;

    const q = request.query as { days?: string };
    const days = parseIntParam(q.days, 30, 90);

    // ai_usage_logs and apps are per-region runtime tables. Fan out across
    // every region and merge the aggregates by their grouping key.
    const [totalsRows, byModelRows, byRouterRows, byUserRows, byAppRows, dailyRows] = await Promise.all([
      fanOutQuery<{ requests: number; tokens: string; cost: string; provider_cost: string; charged_credits: string }>(
        `SELECT count(*)::int AS requests,
                coalesce(sum(total_tokens),0)::bigint AS tokens,
                coalesce(sum(cost_usd),0)::numeric AS cost,
                coalesce(sum(provider_cost_usd),0)::numeric AS provider_cost,
                coalesce(sum(charged_credits_usd),0)::numeric AS charged_credits
         FROM ai_usage_logs
         WHERE created_at >= current_date - $1::int * interval '1 day'`,
        [days]
      ),
      fanOutQuery<{ model: string; provider: string; router: string | null; requests: number; tokens: string; cost_usd: string }>(
        `SELECT model, provider, router,
                count(*)::int AS requests,
                coalesce(sum(total_tokens),0)::bigint AS tokens,
                coalesce(sum(cost_usd),0)::numeric AS cost_usd
         FROM ai_usage_logs
         WHERE created_at >= current_date - $1::int * interval '1 day'
         GROUP BY model, provider, router
         ORDER BY cost_usd DESC`,
        [days]
      ),
      fanOutQuery<{ router: string; requests: number; tokens: string; cost_usd: string }>(
        `SELECT COALESCE(router, '(direct)') AS router,
                count(*)::int AS requests,
                coalesce(sum(total_tokens),0)::bigint AS tokens,
                coalesce(sum(cost_usd),0)::numeric AS cost_usd
         FROM ai_usage_logs
         WHERE created_at >= current_date - $1::int * interval '1 day'
         GROUP BY COALESCE(router, '(direct)')
         ORDER BY cost_usd DESC`,
        [days]
      ),
      fanOutQuery<{ user_id: string; requests: number; tokens: string; cost_usd: string }>(
        `SELECT ap.owner_id AS user_id,
                count(*)::int AS requests,
                coalesce(sum(a.total_tokens),0)::bigint AS tokens,
                coalesce(sum(a.cost_usd),0)::numeric AS cost_usd
         FROM ai_usage_logs a
         JOIN apps ap ON a.app_id = ap.id
         WHERE a.created_at >= current_date - $1::int * interval '1 day'
         GROUP BY ap.owner_id
         ORDER BY cost_usd DESC
         LIMIT 50`,
        [days]
      ),
      fanOutQuery<{ app_id: string; app_name: string; requests: number; tokens: string; cost_usd: string }>(
        `SELECT a.app_id, ap.name AS app_name,
                count(*)::int AS requests,
                coalesce(sum(a.total_tokens),0)::bigint AS tokens,
                coalesce(sum(a.cost_usd),0)::numeric AS cost_usd
         FROM ai_usage_logs a
         JOIN apps ap ON a.app_id = ap.id
         WHERE a.created_at >= current_date - $1::int * interval '1 day'
         GROUP BY a.app_id, ap.name
         ORDER BY cost_usd DESC
         LIMIT 50`,
        [days]
      ),
      fanOutQuery<{ date: string; requests: number; tokens: string; cost_usd: string }>(
        `SELECT date(created_at) AS date,
                count(*)::int AS requests,
                coalesce(sum(total_tokens),0)::bigint AS tokens,
                coalesce(sum(cost_usd),0)::numeric AS cost_usd
         FROM ai_usage_logs
         WHERE created_at >= current_date - $1::int * interval '1 day'
         GROUP BY date(created_at)
         ORDER BY date ASC`,
        [days]
      ),
    ]);

    // Merge per-region aggregates by grouping key.
    const mergeBy = <K extends string>(
      rows: Array<Record<string, any>>,
      keys: K[],
    ) => {
      const out = new Map<string, any>();
      for (const r of rows) {
        const k = keys.map((kk) => r[kk]).join('|');
        const acc = out.get(k) ?? {
          ...Object.fromEntries(keys.map((kk) => [kk, r[kk]])),
          requests: 0, tokens: 0, cost_usd: 0,
        };
        acc.requests += r.requests;
        acc.tokens += Number(r.tokens);
        acc.cost_usd += parseFloat(r.cost_usd ?? r.cost ?? '0');
        out.set(k, acc);
      }
      return Array.from(out.values()).sort((a, b) => b.cost_usd - a.cost_usd);
    };

    const totalRequests = totalsRows.reduce((acc, r) => acc + r.requests, 0);
    const totalTokens = totalsRows.reduce((acc, r) => acc + Number(r.tokens), 0);
    const totalCostUsd = totalsRows.reduce((acc, r) => acc + parseFloat(r.cost), 0);
    const totalProviderCostUsd = totalsRows.reduce((acc, r) => acc + parseFloat(r.provider_cost ?? '0'), 0);
    const totalChargedCreditsUsd = totalsRows.reduce((acc, r) => acc + parseFloat(r.charged_credits ?? '0'), 0);

    const byModelMerged = mergeBy(byModelRows, ['model', 'provider', 'router']);
    const byModel = byModelMerged.map((r: any) => ({
      ...r,
      router: r.router ?? null,
    }));
    const byRouter = mergeBy(byRouterRows, ['router']);
    const byUserMerged = mergeBy(byUserRows, ['user_id']).slice(0, 50);
    const byApp = mergeBy(byAppRows, ['app_id', 'app_name']).slice(0, 50);
    const dailyMerged = mergeBy(dailyRows, ['date']).sort(
      (a: any, b: any) => (a.date < b.date ? -1 : 1),
    );

    // Enrich byUser with email from controlDb
    const byUserOwnerIds: string[] = byUserMerged.map((r: any) => r.user_id);
    const emailMap = new Map<string, string>();
    if (byUserOwnerIds.length > 0) {
      const emailResult = await app.controlDb.query(
        `SELECT id, email FROM platform_users WHERE id = ANY($1::uuid[])`,
        [byUserOwnerIds]
      );
      for (const r of emailResult.rows) {
        emailMap.set(r.id, r.email);
      }
    }

    return {
      totalRequests,
      totalTokens,
      totalCostUsd,
      totalProviderCostUsd,
      totalChargedCreditsUsd,
      byModel,
      byRouter,
      byUser: byUserMerged.map((r: any) => ({
        ...r,
        email: emailMap.get(r.user_id) ?? null,
      })),
      byApp,
      dailyUsage: dailyMerged,
    };
  });

  // ───── GET /admin/functions ─────
  // Query params: search, limit, offset
  // Returns: { data: FunctionRow[], total: number }
  app.get('/admin/functions', { config: { public: true } }, async (request, reply) => {
    if (!(await checkAdmin(request, reply))) return;

    const q = request.query as {
      search?: string; trigger_type?: string; errors_only?: string;
      sort_by?: string; sort_dir?: string; limit?: string; offset?: string;
    };
    const limit = parseIntParam(q.limit, 50, 200);
    const offset = parseIntParam(q.offset, 0);

    const conditions: string[] = ['f.deleted_at IS NULL'];
    const params: unknown[] = [];
    let idx = 1;

    if (q.search) {
      conditions.push(`(f.name ILIKE $${idx} OR f.app_id ILIKE $${idx})`);
      params.push(`%${q.search}%`);
      idx++;
    }
    if (q.trigger_type) {
      conditions.push(`EXISTS (SELECT 1 FROM function_triggers ft
                                 WHERE ft.function_id = f.id
                                   AND ft.trigger_type = $${idx} AND ft.enabled)`);
      params.push(q.trigger_type);
      idx++;
    }
    if (q.errors_only === 'true') {
      conditions.push(`f.error_count > 0`);
    }

    const where = `WHERE ${conditions.join(' AND ')}`;
    const orderBy = buildOrderBy(q.sort_by, q.sort_dir, {
      invocation_count: 'f.invocation_count',
      error_count: 'f.error_count',
      error_rate: 'CASE WHEN f.invocation_count > 0 THEN f.error_count::float / f.invocation_count ELSE 0 END',
      avg_duration_ms: 'f.avg_duration_ms',
      last_invoked_at: 'f.last_invoked_at',
      name: 'f.name',
    }, 'ORDER BY f.invocation_count DESC NULLS LAST');

    const fetchCap = Math.min(limit + offset, 1000);
    const perRegion = await fanOutRuntimeRegions(async (pool) => {
      const [d, c] = await Promise.all([
        pool.query<any>(
          `SELECT f.id, f.app_id, ap.name AS app_name, f.name,
                  COALESCE(
                    (SELECT array_agg(ft.trigger_type ORDER BY ft.trigger_type)
                       FROM function_triggers ft
                      WHERE ft.function_id = f.id AND ft.enabled),
                    '{}'::text[]
                  ) AS trigger_types,
                  f.invocation_count::int, f.error_count::int,
                  f.avg_duration_ms::numeric, f.last_invoked_at, f.deployed_at
           FROM app_functions f
           JOIN apps ap ON f.app_id = ap.id
           ${where}
           ${orderBy}
           LIMIT $${idx}`,
          [...params, fetchCap]
        ),
        pool.query<{ total: number }>(
          `SELECT count(*)::int AS total FROM app_functions f ${where}`,
          params
        ),
      ]);
      return { rows: d.rows, total: c.rows[0].total };
    });

    const mergedRows = perRegion.flatMap((r) => r.result.rows);
    const totalCount = perRegion.reduce((acc, r) => acc + r.result.total, 0);

    // Re-apply ordering globally after merge.
    const sortDir = (q.sort_dir ?? 'desc').toLowerCase() === 'asc' ? 1 : -1;
    const cmpKey = (q.sort_by ?? 'invocation_count') as string;
    mergedRows.sort((a: any, b: any) => {
      const av = a[cmpKey];
      const bv = b[cmpKey];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return av < bv ? -sortDir : av > bv ? sortDir : 0;
    });

    return {
      data: mergedRows.slice(offset, offset + limit).map((r: any) => ({
        ...r,
        // Back-compat single-value field for callers (e.g. admin-dashboard)
        // that still expect `trigger_type` as a string. `trigger_types` is the
        // canonical post-cutover field.
        trigger_type: r.trigger_types?.[0] ?? null,
        avg_duration_ms: r.avg_duration_ms ? parseFloat(r.avg_duration_ms) : 0,
      })),
      total: totalCount,
    };
  });

  // ───── GET /admin/function-invocations ─────
  // Query params: function_id, app_id, limit, offset
  // Returns: { data: FunctionInvocationRow[], total: number }
  app.get('/admin/function-invocations', { config: { public: true } }, async (request, reply) => {
    if (!(await checkAdmin(request, reply))) return;

    const q = request.query as { function_id?: string; app_id?: string; limit?: string; offset?: string };
    const limit = parseIntParam(q.limit, 50, 200);
    const offset = parseIntParam(q.offset, 0);

    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (q.function_id) {
      conditions.push(`fi.function_id = $${idx++}`);
      params.push(q.function_id);
    }
    if (q.app_id) {
      conditions.push(`fi.app_id = $${idx++}`);
      params.push(q.app_id);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const fetchCap = Math.min(limit + offset, 1000);
    const perRegion = await fanOutRuntimeRegions(async (pool) => {
      const [d, c] = await Promise.all([
        pool.query<any>(
          `SELECT fi.id, f.name AS function_name, fi.app_id, fi.status_code,
                  fi.duration_ms, fi.error_message, fi.started_at
           FROM function_invocations fi
           JOIN app_functions f ON fi.function_id = f.id
           ${where}
           ORDER BY fi.started_at DESC
           LIMIT $${idx}`,
          [...params, fetchCap]
        ),
        pool.query<{ total: number }>(
          `SELECT count(*)::int AS total FROM function_invocations fi ${where}`,
          params
        ),
      ]);
      return { rows: d.rows, total: c.rows[0].total };
    });

    const mergedRows = perRegion.flatMap((r) => r.result.rows);
    const totalCount = perRegion.reduce((acc, r) => acc + r.result.total, 0);
    mergedRows.sort(
      (a: any, b: any) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime(),
    );

    return { data: mergedRows.slice(offset, offset + limit), total: totalCount };
  });

  // ───── GET /admin/audit-events ─────
  // Query params: category, event_type, app_id, actor_type, success, limit, offset
  // Returns: { data: AuditEventRow[], total: number }
  app.get('/admin/audit-events', { config: { public: true } }, async (request, reply) => {
    if (!(await checkAdmin(request, reply))) return;

    const q = request.query as {
      category?: string; event_type?: string; app_id?: string; actor_id?: string;
      actor_type?: string; success?: string; from?: string; to?: string;
      sort_by?: string; sort_dir?: string; limit?: string; offset?: string;
    };
    const limit = parseIntParam(q.limit, 50, 200);
    const offset = parseIntParam(q.offset, 0);

    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (q.category) { conditions.push(`category = $${idx++}`); params.push(q.category); }
    if (q.event_type) { conditions.push(`event_type = $${idx++}`); params.push(q.event_type); }
    if (q.app_id) { conditions.push(`app_id = $${idx++}`); params.push(q.app_id); }
    if (q.actor_id) { conditions.push(`actor_id = $${idx++}`); params.push(q.actor_id); }
    if (q.actor_type) { conditions.push(`actor_type = $${idx++}`); params.push(q.actor_type); }
    if (q.success !== undefined && q.success !== '') {
      conditions.push(`success = $${idx++}`);
      params.push(q.success === 'true');
    }
    if (q.from) { conditions.push(`created_at >= $${idx++}`); params.push(q.from); }
    if (q.to) { conditions.push(`created_at < ($${idx++}::date + interval '1 day')`); params.push(q.to); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const orderBy = buildOrderBy(q.sort_by, q.sort_dir, {
      created_at: 'created_at',
    }, 'ORDER BY created_at DESC');

    // FIXME(audit_events-tier): audit_events spans both app_user/anonymous (runtime) and
    // admin/operator (control) actor_types. This admin query fetches all actor_types so
    // it cannot be cleanly migrated without knowing which rows live in which tier.
    const [dataResult, countResult] = await Promise.all([
      app.controlDb.query(
        `SELECT id, app_id, category, event_type, action, resource_type, resource_id,
                actor_type, actor_id, success, error_message, created_at
         FROM audit_events
         ${where}
         ${orderBy}
         LIMIT $${idx++} OFFSET $${idx}`,
        [...params, limit, offset]
      ),
      app.controlDb.query(
        `SELECT count(*)::int AS total FROM audit_events ${where}`,
        params
      ),
    ]);

    return { data: dataResult.rows, total: countResult.rows[0].total };
  });

  // ───── GET /admin/billing ─────
  // Returns: BillingSummary
  app.get('/admin/integrations', { config: { public: true } }, async (request, reply) => {
    if (!(await checkAdmin(request, reply))) return;

    // Per-region runtime tables; sum across all regions.
    const [configsRows, accountsRows, toolkitsRows] = await Promise.all([
      fanOutQuery<{ total_configs: number; apps_with_integrations: number }>(
        `SELECT COUNT(*)::int AS total_configs, COUNT(DISTINCT app_id)::int AS apps_with_integrations
         FROM app_integration_configs WHERE enabled = true`
      ),
      fanOutQuery<{ total_connections: number; unique_users: number }>(
        `SELECT COUNT(*)::int AS total_connections,
                COUNT(DISTINCT app_user_id)::int AS unique_users
         FROM app_connected_accounts WHERE status = 'active'`
      ),
      fanOutQuery<{ toolkit_slug: string; connection_count: number }>(
        `SELECT toolkit_slug, COUNT(*)::int AS connection_count
         FROM app_connected_accounts WHERE status = 'active'
         GROUP BY toolkit_slug ORDER BY connection_count DESC LIMIT 10`
      ),
    ]);

    // Merge top toolkits by slug across regions, then take top 10.
    const toolkitMap = new Map<string, number>();
    for (const r of toolkitsRows) {
      toolkitMap.set(r.toolkit_slug, (toolkitMap.get(r.toolkit_slug) ?? 0) + r.connection_count);
    }
    const top_toolkits = Array.from(toolkitMap.entries())
      .map(([toolkit_slug, connection_count]) => ({ toolkit_slug, connection_count }))
      .sort((a, b) => b.connection_count - a.connection_count)
      .slice(0, 10);

    return reply.send({
      total_configs: configsRows.reduce((acc, r) => acc + r.total_configs, 0),
      apps_with_integrations: configsRows.reduce((acc, r) => acc + r.apps_with_integrations, 0),
      total_connections: accountsRows.reduce((acc, r) => acc + r.total_connections, 0),
      unique_users: accountsRows.reduce((acc, r) => acc + r.unique_users, 0),
      top_toolkits,
    });
  });

  app.get('/admin/billing', { config: { public: true } }, async (request, reply) => {
    if (!(await checkAdmin(request, reply))) return;

    const [activeSubs, planDist, recentEvents, mrr, enterpriseSubs] = await Promise.all([
      app.controlDb.query(
        `SELECT count(*)::int AS c FROM subscriptions WHERE status = 'active'`
      ),
      app.controlDb.query(
        `SELECT p.id AS plan_id, p.name AS plan_name,
                count(s.*)::int AS count,
                (count(s.*)::int * GREATEST(p.price_monthly_cents, 0))::int AS revenue_cents
         FROM plans p
         LEFT JOIN subscriptions s ON s.plan_id = p.id AND s.status = 'active'
         GROUP BY p.id, p.name, p.price_monthly_cents
         ORDER BY revenue_cents DESC`
      ),
      app.controlDb.query(
        `SELECT be.id, be.user_id, pu.email, be.event_type, be.created_at
         FROM billing_events be
         JOIN platform_users pu ON be.user_id = pu.id
         ORDER BY be.created_at DESC
         LIMIT 20`
      ),
      app.controlDb.query(
        `SELECT coalesce(sum(GREATEST(p.price_monthly_cents, 0)), 0)::int AS mrr
         FROM subscriptions s
         JOIN plans p ON s.plan_id = p.id
         WHERE s.status = 'active'`
      ),
      app.controlDb.query(
        `SELECT s.stripe_subscription_id
         FROM subscriptions s
         JOIN platform_users pu ON pu.id = s.user_id
         WHERE s.status IN ('active', 'trialing')
           AND pu.plan_id = 'enterprise'
           AND s.stripe_subscription_id IS NOT NULL`
      ),
    ]);

    // Compute enterprise MRR via live Stripe lookups (custom pricing — sentinel -1 in plans table)
    let enterpriseMrrCents = 0;
    if (enterpriseSubs.rows.length > 0) {
      const t0 = Date.now();
      const stripe = await getStripeClient();
      const results = await Promise.allSettled(
        enterpriseSubs.rows.map((row: any) =>
          stripe.subscriptions.retrieve(row.stripe_subscription_id)
        )
      );
      for (const result of results) {
        if (result.status === 'fulfilled') {
          const unitAmount = result.value.items?.data?.[0]?.price?.unit_amount ?? 0;
          enterpriseMrrCents += unitAmount ?? 0;
        } else {
          request.log.warn({ err: result.reason }, 'billing: failed to retrieve enterprise stripe subscription');
        }
      }
      request.log.info({ enterpriseSubCount: enterpriseSubs.rows.length, enterpriseMrrCents, ms: Date.now() - t0 }, 'billing: enterprise stripe lookup complete');
    }

    const baseMrr: number = mrr.rows[0].mrr;
    const totalMrr = baseMrr + enterpriseMrrCents;

    // Replace the SQL-derived enterprise revenue_cents (which used sentinel 0 after GREATEST) with live Stripe value
    const distribution = planDist.rows.map((r: any) => {
      if (r.plan_id === 'enterprise') {
        return { ...r, revenue_cents: enterpriseMrrCents };
      }
      return r;
    });

    const totalRevenue = distribution.reduce((sum: number, r: any) => sum + r.revenue_cents, 0);

    return {
      totalRevenueCents: totalRevenue,
      activeSubscriptions: activeSubs.rows[0].c,
      planDistribution: distribution,
      recentEvents: recentEvents.rows,
      mrrCents: totalMrr,
    };
  });

  // ───── GET /admin/users/:id ─────
  // Returns: composite user detail (profile, apps, AI usage, audit events, suggestions)
  app.get('/admin/users/:id', { config: { public: true } }, async (request, reply) => {
    if (!(await checkAdmin(request, reply))) return;

    const { id } = request.params as { id: string };

    const [userResult, suggestionsResult] = await Promise.all([
      app.controlDb.query(
        `SELECT id, email, display_name, plan_id, account_status, stripe_customer_id, created_at
         FROM platform_users WHERE id = $1`,
        [id]
      ),
      app.controlDb.query(
        `SELECT id, category, severity, description, affected_tool, status, created_at
         FROM suggestions
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT 10`,
        [id]
      ),
    ]);

    if (userResult.rows.length === 0) {
      return reply.code(404).send({ error: 'User not found' });
    }

    // Apps + AI usage live in per-region runtime DBs — fan out + merge.
    const [appsRows, aiByModelRows, aiDailyRows, auditResult] = await Promise.all([
      fanOutQuery<any>(
        `SELECT a.id, a.name, a.region, a.db_provisioned, a.deployment_url,
                a.last_deployed_at, a.created_at,
                coalesce(fc.fn_count, 0)::int AS function_count
         FROM apps a
         LEFT JOIN LATERAL (
           SELECT count(*) AS fn_count FROM app_functions WHERE app_id = a.id AND deleted_at IS NULL
         ) fc ON true
         WHERE a.owner_id = $1
         ORDER BY a.created_at DESC`,
        [id]
      ),
      fanOutQuery<{ model: string; requests: number; tokens: string; cost_usd: string }>(
        `SELECT model, count(*)::int AS requests,
                coalesce(sum(total_tokens),0)::bigint AS tokens,
                coalesce(sum(cost_usd),0)::numeric AS cost_usd
         FROM ai_usage_logs
         WHERE app_id IN (SELECT a.id FROM apps a WHERE a.owner_id = $1)
         GROUP BY model
         ORDER BY cost_usd DESC`,
        [id]
      ),
      fanOutQuery<{ date: string; requests: number; tokens: string; cost_usd: string }>(
        `SELECT date(created_at) AS date,
                count(*)::int AS requests,
                coalesce(sum(total_tokens),0)::bigint AS tokens,
                coalesce(sum(cost_usd),0)::numeric AS cost_usd
         FROM ai_usage_logs
         WHERE app_id IN (SELECT a.id FROM apps a WHERE a.owner_id = $1)
           AND created_at >= current_date - interval '30 days'
         GROUP BY date(created_at)
         ORDER BY date ASC`,
        [id]
      ),
      // FIXME(audit_events-tier): audit_events spans both app_user/anonymous (runtime) and
      // admin/operator (control) actor_types; left on controlDb until tier is resolved.
      app.controlDb.query(
        `SELECT id, app_id, category, event_type, action, resource_type, resource_id,
                actor_type, actor_id, success, error_message, created_at
         FROM audit_events
         WHERE actor_id = $1
         ORDER BY created_at DESC
         LIMIT 20`,
        [id]
      ),
    ]);

    // Merge by model
    const byModelMap = new Map<string, { model: string; requests: number; tokens: number; cost_usd: number }>();
    for (const r of aiByModelRows) {
      const acc = byModelMap.get(r.model) ?? { model: r.model, requests: 0, tokens: 0, cost_usd: 0 };
      acc.requests += r.requests;
      acc.tokens += Number(r.tokens);
      acc.cost_usd += parseFloat(r.cost_usd);
      byModelMap.set(r.model, acc);
    }
    const byModel = Array.from(byModelMap.values()).sort((a, b) => b.cost_usd - a.cost_usd);

    // Merge by date
    const byDateMap = new Map<string, { date: string; requests: number; tokens: number; cost_usd: number }>();
    for (const r of aiDailyRows) {
      const k = String(r.date);
      const acc = byDateMap.get(k) ?? { date: k, requests: 0, tokens: 0, cost_usd: 0 };
      acc.requests += r.requests;
      acc.tokens += Number(r.tokens);
      acc.cost_usd += parseFloat(r.cost_usd);
      byDateMap.set(k, acc);
    }
    const dailyUsage = Array.from(byDateMap.values()).sort((a, b) => (a.date < b.date ? -1 : 1));

    const totalRequests = byModel.reduce((acc, r) => acc + r.requests, 0);
    const totalTokens = byModel.reduce((acc, r) => acc + r.tokens, 0);
    const totalCostUsd = byModel.reduce((acc, r) => acc + r.cost_usd, 0);

    // Sort merged apps by created_at desc
    appsRows.sort(
      (a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );

    return {
      user: userResult.rows[0],
      apps: appsRows,
      aiUsage: {
        totalRequests,
        totalTokens,
        totalCostUsd,
        byModel,
        dailyUsage,
      },
      recentAuditEvents: auditResult.rows,
      recentSuggestions: suggestionsResult.rows,
    };
  });

  // ───── GET /admin/apps/:id ─────
  // Returns: composite app detail (app, functions, invocations, AI usage, audit events)
  app.get('/admin/apps/:id', { config: { public: true } }, async (request, reply) => {
    if (!(await checkAdmin(request, reply))) return;

    const { id } = request.params as { id: string };

    // Per-app routes: resolve the app's home region once, then run all
    // runtime queries on that region's pool. apps/app_functions/etc.
    // exist in only one region per app, so no fan-out is needed here.
    let runtimePool;
    try {
      runtimePool = await getRuntimeDbForApp(app.controlDb, id);
    } catch {
      return reply.code(404).send({ error: 'App not found' });
    }
    const [appRuntimeResult, functionsResult, invocationsResult, aiByModel, auditResult] = await Promise.all([
      runtimePool.query(
        `SELECT a.id, a.name, a.region, a.db_provisioned, a.deployment_url,
                a.last_deployed_at, a.created_at, a.owner_id
         FROM apps a
         WHERE a.id = $1`,
        [id]
      ),
      runtimePool.query(
        `SELECT f.id, f.name,
                COALESCE(
                  (SELECT array_agg(ft.trigger_type ORDER BY ft.trigger_type)
                     FROM function_triggers ft
                    WHERE ft.function_id = f.id AND ft.enabled),
                  '{}'::text[]
                ) AS trigger_types,
                f.invocation_count::int, f.error_count::int,
                f.avg_duration_ms::numeric, f.last_invoked_at, f.deployed_at
         FROM app_functions f
         WHERE f.app_id = $1 AND f.deleted_at IS NULL
         ORDER BY f.invocation_count DESC`,
        [id]
      ),
      runtimePool.query(
        `SELECT fi.id, f.name AS function_name, fi.status_code,
                fi.duration_ms, fi.error_message, fi.started_at
         FROM function_invocations fi
         JOIN app_functions f ON fi.function_id = f.id
         WHERE fi.app_id = $1
         ORDER BY fi.started_at DESC
         LIMIT 20`,
        [id]
      ),
      runtimePool.query(
        `SELECT model, count(*)::int AS requests,
                coalesce(sum(total_tokens),0)::bigint AS tokens,
                coalesce(sum(cost_usd),0)::numeric AS cost_usd
         FROM ai_usage_logs
         WHERE app_id = $1
         GROUP BY model
         ORDER BY cost_usd DESC`,
        [id]
      ),
      // FIXME(audit_events-tier): audit_events spans both app_user/anonymous (runtime) and
      // admin/operator (control) actor_types; left on controlDb until tier is resolved.
      app.controlDb.query(
        `SELECT id, app_id, category, event_type, action, resource_type, resource_id,
                actor_type, actor_id, success, error_message, created_at
         FROM audit_events
         WHERE app_id = $1
         ORDER BY created_at DESC
         LIMIT 20`,
        [id]
      ),
    ]);

    if (appRuntimeResult.rows.length === 0) {
      return reply.code(404).send({ error: 'App not found' });
    }

    // Enrich with owner_email from controlDb (platform tier)
    const appRow = appRuntimeResult.rows[0];
    const ownerResult = await app.controlDb.query(
      `SELECT id, email FROM platform_users WHERE id = $1`,
      [appRow.owner_id]
    );
    const ownerEmail = ownerResult.rows[0]?.email ?? null;

    const aiTotals = aiByModel.rows.reduce(
      (acc: { requests: number; tokens: number; cost: number }, r: any) => ({
        requests: acc.requests + r.requests,
        tokens: acc.tokens + Number(r.tokens),
        cost: acc.cost + parseFloat(r.cost_usd),
      }),
      { requests: 0, tokens: 0, cost: 0 }
    );

    return {
      app: { ...appRow, owner_email: ownerEmail },
      functions: functionsResult.rows.map((r: any) => ({
        ...r,
        trigger_type: r.trigger_types?.[0] ?? null,
        avg_duration_ms: r.avg_duration_ms ? parseFloat(r.avg_duration_ms) : 0,
      })),
      recentInvocations: invocationsResult.rows,
      aiUsage: {
        totalRequests: aiTotals.requests,
        totalTokens: aiTotals.tokens,
        totalCostUsd: aiTotals.cost,
        byModel: aiByModel.rows.map((r: any) => ({
          model: r.model,
          requests: r.requests,
          tokens: Number(r.tokens),
          cost_usd: parseFloat(r.cost_usd),
        })),
      },
      recentAuditEvents: auditResult.rows,
    };
  });

  // ───── GET /admin/functions/:id ─────
  // Returns: function detail with invocations and error summary
  app.get('/admin/functions/:id', { config: { public: true } }, async (request, reply) => {
    if (!(await checkAdmin(request, reply))) return;

    const { id } = request.params as { id: string };

    // function_id is globally unique but app_functions is per-region. Find
    // it by scanning each region's pool until one returns a row, then
    // continue with that region's pool.
    const perRegion = await fanOutRuntimeRegions(async (pool) => {
      const r = await pool.query<{ app_id: string }>(
        `SELECT app_id FROM app_functions WHERE id = $1`,
        [id]
      );
      return r.rows[0]?.app_id ?? null;
    });
    const owningRegion = perRegion.find((p) => p.result !== null);
    if (!owningRegion) {
      return reply.code(404).send({ error: 'Function not found' });
    }
    const runtimePool = await getRuntimeDbForApp(app.controlDb, owningRegion.result!);

    const [fnResult, invocationsResult, errorSummaryResult] = await Promise.all([
      runtimePool.query(
        `SELECT f.id, f.app_id, ap.name AS app_name, f.name,
                COALESCE(
                  (SELECT array_agg(ft.trigger_type ORDER BY ft.trigger_type)
                     FROM function_triggers ft
                    WHERE ft.function_id = f.id AND ft.enabled),
                  '{}'::text[]
                ) AS trigger_types,
                f.invocation_count::int, f.error_count::int,
                f.avg_duration_ms::numeric, f.last_invoked_at, f.deployed_at
         FROM app_functions f
         JOIN apps ap ON f.app_id = ap.id
         WHERE f.id = $1`,
        [id]
      ),
      runtimePool.query(
        `SELECT fi.id, fi.status_code, fi.duration_ms, fi.error_message, fi.started_at
         FROM function_invocations fi
         WHERE fi.function_id = $1
         ORDER BY fi.started_at DESC
         LIMIT 50`,
        [id]
      ),
      runtimePool.query(
        `SELECT error_message, count(*)::int AS count,
                max(started_at) AS last_seen
         FROM function_invocations
         WHERE function_id = $1 AND error_message IS NOT NULL
         GROUP BY error_message
         ORDER BY count DESC
         LIMIT 10`,
        [id]
      ),
    ]);

    if (fnResult.rows.length === 0) {
      return reply.code(404).send({ error: 'Function not found' });
    }

    const fn = fnResult.rows[0];

    return {
      function: {
        ...fn,
        trigger_type: fn.trigger_types?.[0] ?? null,
        avg_duration_ms: fn.avg_duration_ms ? parseFloat(fn.avg_duration_ms) : 0,
      },
      recentInvocations: invocationsResult.rows,
      errorSummary: {
        totalErrors: fn.error_count,
        recentErrors: errorSummaryResult.rows,
      },
    };
  });

  // ───── GET /admin/audit-events/:id ─────
  // Returns: full event detail with correlated events and resource history
  app.get('/admin/audit-events/:id', { config: { public: true } }, async (request, reply) => {
    if (!(await checkAdmin(request, reply))) return;

    const { id } = request.params as { id: string };

    // FIXME(audit_events-tier): audit_events spans both app_user/anonymous (runtime) and
    // admin/operator (control) actor_types; left on controlDb until tier is resolved.
    const eventResult = await app.controlDb.query(
      `SELECT id, app_id, category, event_type, action, resource_type, resource_id,
              actor_type, actor_id, event_data, ip_address::text, user_agent,
              correlation_id, success, error_message, created_at
       FROM audit_events
       WHERE id = $1`,
      [id]
    );

    if (eventResult.rows.length === 0) {
      return reply.code(404).send({ error: 'Audit event not found' });
    }

    const event = eventResult.rows[0];

    const [correlatedResult, resourceResult] = await Promise.all([
      event.correlation_id
        ? app.controlDb.query(
            `SELECT id, app_id, category, event_type, action, resource_type, resource_id,
                    actor_type, actor_id, success, error_message, created_at
             FROM audit_events
             WHERE correlation_id = $1 AND id != $2
             ORDER BY created_at DESC
             LIMIT 20`,
            [event.correlation_id, id]
          )
        : Promise.resolve({ rows: [] }),
      event.resource_type && event.resource_id
        ? app.controlDb.query(
            `SELECT id, app_id, category, event_type, action, resource_type, resource_id,
                    actor_type, actor_id, success, error_message, created_at
             FROM audit_events
             WHERE resource_type = $1 AND resource_id = $2 AND id != $3
             ORDER BY created_at DESC
             LIMIT 10`,
            [event.resource_type, event.resource_id, id]
          )
        : Promise.resolve({ rows: [] }),
    ]);

    return {
      event,
      correlatedEvents: correlatedResult.rows,
      resourceHistory: resourceResult.rows,
    };
  });

  // ───── GET /admin/ai-usage/users/:id ─────
  // Returns: AI usage detail for a specific user
  app.get('/admin/ai-usage/users/:id', { config: { public: true } }, async (request, reply) => {
    if (!(await checkAdmin(request, reply))) return;

    const { id } = request.params as { id: string };

    // platform_users → controlDb; ai_usage_logs + apps fan out per region.
    const [userResult, byModelRows, byRouterRows, byAppRows, dailyRows] = await Promise.all([
      app.controlDb.query(
        `SELECT id, email, plan_id FROM platform_users WHERE id = $1`,
        [id]
      ),
      fanOutQuery<{ model: string; provider: string; router: string | null; requests: number; tokens: string; cost_usd: string }>(
        `SELECT model, provider, router, count(*)::int AS requests,
                coalesce(sum(total_tokens),0)::bigint AS tokens,
                coalesce(sum(cost_usd),0)::numeric AS cost_usd
         FROM ai_usage_logs
         WHERE app_id IN (SELECT a.id FROM apps a WHERE a.owner_id = $1)
         GROUP BY model, provider, router
         ORDER BY cost_usd DESC`,
        [id]
      ),
      fanOutQuery<{ router: string; requests: number; tokens: string; cost_usd: string }>(
        `SELECT COALESCE(router, '(direct)') AS router,
                count(*)::int AS requests,
                coalesce(sum(total_tokens),0)::bigint AS tokens,
                coalesce(sum(cost_usd),0)::numeric AS cost_usd
         FROM ai_usage_logs
         WHERE app_id IN (SELECT a.id FROM apps a WHERE a.owner_id = $1)
         GROUP BY COALESCE(router, '(direct)')
         ORDER BY cost_usd DESC`,
        [id]
      ),
      fanOutQuery<{ app_id: string; app_name: string; requests: number; tokens: string; cost_usd: string }>(
        `SELECT a.app_id, ap.name AS app_name,
                count(*)::int AS requests,
                coalesce(sum(a.total_tokens),0)::bigint AS tokens,
                coalesce(sum(a.cost_usd),0)::numeric AS cost_usd
         FROM ai_usage_logs a
         JOIN apps ap ON a.app_id = ap.id
         WHERE ap.owner_id = $1
         GROUP BY a.app_id, ap.name
         ORDER BY cost_usd DESC`,
        [id]
      ),
      fanOutQuery<{ date: string; requests: number; tokens: string; cost_usd: string }>(
        `SELECT date(created_at) AS date,
                count(*)::int AS requests,
                coalesce(sum(total_tokens),0)::bigint AS tokens,
                coalesce(sum(cost_usd),0)::numeric AS cost_usd
         FROM ai_usage_logs
         WHERE app_id IN (SELECT a.id FROM apps a WHERE a.owner_id = $1)
           AND created_at >= current_date - interval '30 days'
         GROUP BY date(created_at)
         ORDER BY date ASC`,
        [id]
      ),
    ]);

    if (userResult.rows.length === 0) {
      return reply.code(404).send({ error: 'User not found' });
    }

    const mergeBy = <K extends string>(
      rows: Array<Record<string, any>>,
      keys: K[],
    ) => {
      const out = new Map<string, any>();
      for (const r of rows) {
        const k = keys.map((kk) => r[kk]).join('|');
        const acc = out.get(k) ?? {
          ...Object.fromEntries(keys.map((kk) => [kk, r[kk]])),
          requests: 0, tokens: 0, cost_usd: 0,
        };
        acc.requests += r.requests;
        acc.tokens += Number(r.tokens);
        acc.cost_usd += parseFloat(r.cost_usd);
        out.set(k, acc);
      }
      return Array.from(out.values()).sort((a, b) => b.cost_usd - a.cost_usd);
    };

    const byModelMerged = mergeBy(byModelRows, ['model', 'provider', 'router']);
    const byModel = byModelMerged.map((r: any) => ({
      ...r,
      router: r.router ?? null,
    }));
    const byRouter = mergeBy(byRouterRows, ['router']);
    const byApp = mergeBy(byAppRows, ['app_id', 'app_name']);
    const dailyUsage = mergeBy(dailyRows, ['date']).sort((a, b) => (a.date < b.date ? -1 : 1));

    const totalRequests = byModel.reduce((acc, r) => acc + r.requests, 0);
    const totalTokens = byModel.reduce((acc, r) => acc + r.tokens, 0);
    const totalCostUsd = byModel.reduce((acc, r) => acc + r.cost_usd, 0);

    return {
      user: userResult.rows[0],
      totalRequests,
      totalTokens,
      totalCostUsd,
      byModel,
      byRouter,
      byApp,
      dailyUsage,
    };
  });

  // ───── GET /admin/ai-usage/apps/:id ─────
  // Returns: AI usage detail for a specific app
  app.get('/admin/ai-usage/apps/:id', { config: { public: true } }, async (request, reply) => {
    if (!(await checkAdmin(request, reply))) return;

    const { id } = request.params as { id: string };

    // Per-app: resolve home region once.
    let runtimePool;
    try {
      runtimePool = await getRuntimeDbForApp(app.controlDb, id);
    } catch {
      return reply.code(404).send({ error: 'App not found' });
    }
    const [appRuntimeResult, byModel, byRouterResult, daily] = await Promise.all([
      runtimePool.query(
        `SELECT a.id, a.name, a.region, a.owner_id
         FROM apps a
         WHERE a.id = $1`,
        [id]
      ),
      runtimePool.query(
        `SELECT model, provider, router, count(*)::int AS requests,
                coalesce(sum(total_tokens),0)::bigint AS tokens,
                coalesce(sum(cost_usd),0)::numeric AS cost_usd
         FROM ai_usage_logs
         WHERE app_id = $1
         GROUP BY model, provider, router
         ORDER BY cost_usd DESC`,
        [id]
      ),
      runtimePool.query(
        `SELECT COALESCE(router, '(direct)') AS router,
                count(*)::int AS requests,
                coalesce(sum(total_tokens),0)::bigint AS tokens,
                coalesce(sum(cost_usd),0)::numeric AS cost_usd
         FROM ai_usage_logs
         WHERE app_id = $1
         GROUP BY COALESCE(router, '(direct)')
         ORDER BY cost_usd DESC`,
        [id]
      ),
      runtimePool.query(
        `SELECT date(created_at) AS date,
                count(*)::int AS requests,
                coalesce(sum(total_tokens),0)::bigint AS tokens,
                coalesce(sum(cost_usd),0)::numeric AS cost_usd
         FROM ai_usage_logs
         WHERE app_id = $1
           AND created_at >= current_date - interval '30 days'
         GROUP BY date(created_at)
         ORDER BY date ASC`,
        [id]
      ),
    ]);

    if (appRuntimeResult.rows.length === 0) {
      return reply.code(404).send({ error: 'App not found' });
    }

    // Enrich with owner_email from controlDb (platform tier)
    const appRow = appRuntimeResult.rows[0];
    const ownerResult = await app.controlDb.query(
      `SELECT email FROM platform_users WHERE id = $1`,
      [appRow.owner_id]
    );
    const ownerEmail = ownerResult.rows[0]?.email ?? null;

    const parseRow = (r: any) => ({
      ...r,
      tokens: Number(r.tokens),
      cost_usd: parseFloat(r.cost_usd),
    });

    const totals = byModel.rows.reduce(
      (acc: { requests: number; tokens: number; cost: number }, r: any) => ({
        requests: acc.requests + r.requests,
        tokens: acc.tokens + Number(r.tokens),
        cost: acc.cost + parseFloat(r.cost_usd),
      }),
      { requests: 0, tokens: 0, cost: 0 }
    );

    return {
      app: { ...appRow, owner_email: ownerEmail },
      totalRequests: totals.requests,
      totalTokens: totals.tokens,
      totalCostUsd: totals.cost,
      byModel: byModel.rows.map((r: any) => ({
        ...parseRow(r),
        router: r.router ?? null,
      })),
      byRouter: byRouterResult.rows.map(parseRow),
      dailyUsage: daily.rows.map(parseRow),
    };
  });

  // ───── GET /admin/billing/plans/:id ─────
  // Returns: plan detail with subscribers and events
  app.get('/admin/billing/plans/:id', { config: { public: true } }, async (request, reply) => {
    if (!(await checkAdmin(request, reply))) return;

    const { id } = request.params as { id: string };

    const [planResult, subscribersResult, eventsResult] = await Promise.all([
      app.controlDb.query(
        `SELECT id, name, price_monthly_cents FROM plans WHERE id = $1`,
        [id]
      ),
      app.controlDb.query(
        `SELECT pu.id AS user_id, pu.email, s.created_at AS subscribed_at
         FROM subscriptions s
         JOIN platform_users pu ON s.user_id = pu.id
         WHERE s.plan_id = $1 AND s.status = 'active'
         ORDER BY s.created_at DESC`,
        [id]
      ),
      app.controlDb.query(
        `SELECT be.id, be.user_id, pu.email, be.event_type, be.created_at
         FROM billing_events be
         JOIN platform_users pu ON be.user_id = pu.id
         JOIN subscriptions s ON be.user_id = s.user_id AND s.plan_id = $1
         ORDER BY be.created_at DESC
         LIMIT 20`,
        [id]
      ),
    ]);

    if (planResult.rows.length === 0) {
      return reply.code(404).send({ error: 'Plan not found' });
    }

    const plan = planResult.rows[0];

    return {
      plan,
      activeSubscribers: subscribersResult.rows.length,
      monthlyRevenueCents: subscribersResult.rows.length * plan.price_monthly_cents,
      subscribers: subscribersResult.rows,
      recentEvents: eventsResult.rows,
    };
  });

  // ───── GET /admin/billing/users/:id ─────
  // Returns: user billing detail with subscription and events
  app.get('/admin/billing/users/:id', { config: { public: true } }, async (request, reply) => {
    if (!(await checkAdmin(request, reply))) return;

    const { id } = request.params as { id: string };

    const [userResult, subResult, eventsResult] = await Promise.all([
      app.controlDb.query(
        `SELECT id, email, plan_id, stripe_customer_id FROM platform_users WHERE id = $1`,
        [id]
      ),
      app.controlDb.query(
        `SELECT p.name AS plan_name, s.plan_id, s.status,
                p.price_monthly_cents, s.created_at AS started_at,
                s.stripe_subscription_id
         FROM subscriptions s
         JOIN plans p ON s.plan_id = p.id
         WHERE s.user_id = $1
         ORDER BY s.created_at DESC
         LIMIT 1`,
        [id]
      ),
      app.controlDb.query(
        `SELECT id, event_type, created_at
         FROM billing_events
         WHERE user_id = $1
         ORDER BY created_at DESC`,
        [id]
      ),
    ]);

    if (userResult.rows.length === 0) {
      return reply.code(404).send({ error: 'User not found' });
    }

    const subscriptionRow = subResult.rows[0] ?? null;

    // Fetch live Stripe price for the active sub (admin-only, infrequent).
    let currentStripePrice: { id: string; unit_amount_cents: number; nickname: string | null } | null = null;
    const stripeSubId = subscriptionRow?.stripe_subscription_id;
    if (stripeSubId) {
      try {
        const stripe = await getStripeClient();
        const sub = await stripe.subscriptions.retrieve(stripeSubId);
        const item = sub.items.data[0];
        if (item) {
          currentStripePrice = {
            id: item.price.id,
            unit_amount_cents: item.price.unit_amount ?? 0,
            nickname: item.price.nickname,
          };
        }
      } catch (err) {
        request.log?.warn({ err, stripeSubId }, 'Failed to fetch Stripe price for user-detail');
      }
    }

    return {
      user: userResult.rows[0],
      subscription: subscriptionRow,
      billingEvents: eventsResult.rows,
      currentStripePrice,
    };
  });

  // ───── GET /admin/billing/users/:id/credits ─────
  // Returns split credit pools + auto-refill state for the admin UI.
  app.get('/admin/billing/users/:id/credits', { config: { public: true } }, async (request, reply) => {
    if (!(await checkAdmin(request, reply))) return;

    const { id } = request.params as { id: string };
    const r = await app.controlDb.query<{
      monthly_allowance_usd: string;
      credits_usd: string;
      auto_refill_enabled: boolean;
      auto_refill_amount_usd: string | null;
      auto_refill_last_attempt_at: Date | null;
      auto_refill_last_failure_reason: string | null;
    }>(
      `SELECT monthly_allowance_usd::text,
              credits_usd::text,
              auto_refill_enabled,
              auto_refill_amount_usd::text,
              auto_refill_last_attempt_at,
              auto_refill_last_failure_reason
         FROM platform_users WHERE id = $1`,
      [id]
    );
    if (r.rows.length === 0) return reply.code(404).send({ error: 'user_not_found' });
    const row = r.rows[0];
    const monthly = parseFloat(row.monthly_allowance_usd);
    const topup = parseFloat(row.credits_usd);
    return {
      credits: {
        monthly_allowance_usd: monthly,
        topup_usd: topup,
        total_usd: monthly + topup,
      },
      auto_refill: {
        enabled: row.auto_refill_enabled,
        amount_usd: row.auto_refill_amount_usd != null ? parseFloat(row.auto_refill_amount_usd) : null,
        last_attempt_at: row.auto_refill_last_attempt_at,
        last_failure_reason: row.auto_refill_last_failure_reason,
      },
    };
  });

  // ───── GET /admin/billing/users/:id/credits/ledger ─────
  // Cursor-paginated ledger of credit grants, leases, monthly resets — one chronological stream.
  app.get('/admin/billing/users/:id/credits/ledger', { config: { public: true } }, async (request, reply) => {
    if (!(await checkAdmin(request, reply))) return;
    const { id } = request.params as { id: string };
    const { cursor, limit } = request.query as { cursor?: string; limit?: string };
    const lim = Math.min(parseInt(limit ?? '50', 10) || 50, 200);

    const params: unknown[] = [id, lim];
    let cursorClause = '';
    if (cursor) {
      params.push(cursor);
      cursorClause = `AND occurred_at < $3`;
    }

    const r = await app.controlDb.query<{
      id: string;
      occurred_at: Date | string;
      type: string;
      amount_usd: string;
      pool: string | null;
      lease_id: string | null;
      note: string | null;
    }>(
      `SELECT id,
              occurred_at,
              type,
              amount_usd::text,
              pool,
              lease_id,
              note
         FROM (
           -- credit grants (signup, auto_refill, manual, refund)
           SELECT id::text            AS id,
                  created_at          AS occurred_at,
                  reason              AS type,
                  amount_usd,
                  'topup'::text       AS pool,
                  NULL::text          AS lease_id,
                  stripe_event_id     AS note
             FROM credit_grants
            WHERE user_id = $1

           UNION ALL

           -- monthly allowance resets (set by Stripe renewal)
           SELECT id::text                   AS id,
                  created_at                 AS occurred_at,
                  'monthly_reset'::text      AS type,
                  amount_usd,
                  'monthly'::text            AS pool,
                  NULL::text                 AS lease_id,
                  stripe_event_id            AS note
             FROM monthly_credit_resets
            WHERE user_id = $1

           UNION ALL

           -- credit leases (active, expired, reclaimed, returned, settled)
           SELECT lease_id::text    AS id,
                  granted_at        AS occurred_at,
                  'lease_' || status AS type,
                  amount_usd,
                  source_pool       AS pool,
                  lease_id::text    AS lease_id,
                  region            AS note
             FROM credit_leases
            WHERE user_id = $1
         ) AS ledger
        WHERE TRUE ${cursorClause}
        ORDER BY occurred_at DESC
        LIMIT $2`,
      params
    );

    const rows = r.rows.map((row) => ({
      id: row.id,
      occurred_at: row.occurred_at,
      type: row.type,
      amount_usd: parseFloat(row.amount_usd),
      pool: row.pool,
      lease_id: row.lease_id,
      note: row.note,
    }));

    return {
      rows,
      nextCursor:
        rows.length === lim
          ? rows[rows.length - 1].occurred_at instanceof Date
            ? (rows[rows.length - 1].occurred_at as Date).toISOString()
            : String(rows[rows.length - 1].occurred_at)
          : null,
    };
  });

  // ───── GET /admin/signups-trend ─────
  // Query params: days (default 30, max 365), period (day|week|month, default day)
  // Returns: { data: Array<{ period: string; signups: number; cumulative: number }> }
  app.get('/admin/signups-trend', { config: { public: true } }, async (request, reply) => {
    if (!(await checkAdmin(request, reply))) return;

    const q = request.query as { days?: string; period?: string };
    const days = parseIntParam(q.days, 30, 365);
    const period = parsePeriodParam(q.period);

    const result = await app.controlDb.query(
      `SELECT date_trunc('${period}', created_at)::date AS period,
              count(*)::int AS signups
       FROM platform_users
       WHERE created_at >= now() - $1 * interval '1 day'
       GROUP BY 1
       ORDER BY 1 ASC`,
      [days],
    );

    let cumulative = 0;
    return {
      data: result.rows.map((r: any) => {
        cumulative += r.signups;
        return { period: r.period, signups: r.signups, cumulative };
      }),
    };
  });

  // ───── GET /admin/mrr-trend ─────
  // Query params: days (default 90, max 365)
  // Returns: { data: Array<{ period: string; new_subs: number; cancellations: number; payments: number }> }
  app.get('/admin/mrr-trend', { config: { public: true } }, async (request, reply) => {
    if (!(await checkAdmin(request, reply))) return;

    const q = request.query as { days?: string };
    const days = parseIntParam(q.days, 90, 365);

    const result = await app.controlDb.query(
      `SELECT date_trunc('month', created_at)::date AS period,
              count(*) FILTER (WHERE event_type = 'subscription_created')::int  AS new_subs,
              count(*) FILTER (WHERE event_type = 'subscription_canceled')::int AS cancellations,
              count(*) FILTER (WHERE event_type = 'payment_succeeded')::int     AS payments
       FROM billing_events
       WHERE created_at >= now() - $1 * interval '1 day'
       GROUP BY 1
       ORDER BY 1 ASC`,
      [days],
    );

    return { data: result.rows };
  });

  // ───── GET /admin/apps-trend ─────
  // Query params: days (default 30, max 365), period (day|week|month, default day)
  // Returns: { data: Array<{ period: string; apps_created: number; cumulative: number }> }
  app.get('/admin/apps-trend', { config: { public: true } }, async (request, reply) => {
    if (!(await checkAdmin(request, reply))) return;

    const q = request.query as { days?: string; period?: string };
    const days = parseIntParam(q.days, 30, 365);
    const period = parsePeriodParam(q.period);

    // apps is per-region; sum apps_created per period across regions.
    const rows = await fanOutQuery<{ period: string; apps_created: number }>(
      `SELECT date_trunc('${period}', created_at)::date AS period,
              count(*)::int AS apps_created
       FROM apps
       WHERE created_at >= now() - $1 * interval '1 day'
       GROUP BY 1
       ORDER BY 1 ASC`,
      [days],
    );

    const merged = new Map<string, number>();
    for (const r of rows) {
      const k = String(r.period);
      merged.set(k, (merged.get(k) ?? 0) + r.apps_created);
    }
    const sortedPeriods = Array.from(merged.entries()).sort(
      (a, b) => (a[0] < b[0] ? -1 : 1),
    );
    let cumulative = 0;
    return {
      data: sortedPeriods.map(([period, apps_created]) => {
        cumulative += apps_created;
        return { period, apps_created, cumulative };
      }),
    };
  });

  // ───── GET /admin/invocations-trend ─────
  // Query params: days (default 30, max 90 — capped due to invocations table volume)
  // Returns: { data: Array<{ period: string; invocations: number; errors: number }> }
  app.get('/admin/invocations-trend', { config: { public: true } }, async (request, reply) => {
    if (!(await checkAdmin(request, reply))) return;

    const q = request.query as { days?: string };
    const days = parseIntParam(q.days, 30, 90);

    // function_invocations is per-region; sum per period across regions.
    const rows = await fanOutQuery<{ period: string; invocations: number; errors: number }>(
      `SELECT date(started_at) AS period,
              count(*)::int AS invocations,
              count(*) FILTER (WHERE status_code >= 400 OR error_message IS NOT NULL)::int AS errors
       FROM function_invocations
       WHERE started_at >= now() - $1 * interval '1 day'
       GROUP BY date(started_at)
       ORDER BY period ASC`,
      [days],
    );

    const merged = new Map<string, { invocations: number; errors: number }>();
    for (const r of rows) {
      const k = String(r.period);
      const acc = merged.get(k) ?? { invocations: 0, errors: 0 };
      acc.invocations += r.invocations;
      acc.errors += r.errors;
      merged.set(k, acc);
    }
    const data = Array.from(merged.entries())
      .map(([period, v]) => ({ period, ...v }))
      .sort((a, b) => (a.period < b.period ? -1 : 1));
    return { data };
  });

  // ───── GET /admin/audit-stats ─────
  // No query params — fixed 30-day window
  // Returns: { byCategory: Array<{ category: string; count: number; success: number; failure: number }>, dailyVolume: Array<{ date: string; count: number }> }
  app.get('/admin/audit-stats', { config: { public: true } }, async (request, reply) => {
    if (!(await checkAdmin(request, reply))) return;

    // FIXME(audit_events-tier): audit_events spans both app_user/anonymous (runtime) and
    // admin/operator (control) actor_types; left on controlDb until tier is resolved.
    const [byCategory, dailyVolume] = await Promise.all([
      app.controlDb.query(
        `SELECT category,
                count(*)::int                                          AS count,
                count(*) FILTER (WHERE success = true)::int           AS success,
                count(*) FILTER (WHERE success = false)::int          AS failure
         FROM audit_events
         WHERE created_at >= now() - interval '30 days'
         GROUP BY category
         ORDER BY count DESC`,
      ),
      app.controlDb.query(
        `SELECT date(created_at) AS date,
                count(*)::int AS count
         FROM audit_events
         WHERE created_at >= now() - interval '30 days'
         GROUP BY date(created_at)
         ORDER BY date ASC`,
      ),
    ]);

    return {
      byCategory: byCategory.rows,
      dailyVolume: dailyVolume.rows,
    };
  });

  // ───── GET /admin/ai-router/catalog ─────
  // Returns the in-Redis AI catalog: list of canonical models + freshness metadata.
  app.get('/admin/ai-router/catalog', { config: { public: true } }, async (request, reply) => {
    if (!(await checkAdmin(request, reply))) return;
    try {
      const { listCatalogModels, getCatalogMeta, readCatalogEntry } = await import('../services/ai-router/catalog.js');
      const { getRedisClient } = await import('../services/redis.js');
      const redis = getRedisClient();
      const ids = await listCatalogModels(redis);
      const meta = await getCatalogMeta(redis);
      // Read entries so the dashboard can show per-router pricing without
      // an additional fan-out. listCatalogModels returns just canonical ids.
      const entries = await Promise.all(ids.map((id) => readCatalogEntry(redis, id)));
      const models = entries.filter((e): e is NonNullable<typeof e> => e !== null);
      return {
        lastRefreshedAt: meta.lastRefreshedAt,
        modelCount: meta.modelCount,
        models,
      };
    } catch (err) {
      app.log.error({ err }, 'admin: catalog read failed');
      return reply.code(500).send({
        error: 'catalog_unavailable',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // ───── POST /admin/ai-router/refresh-catalog ─────
  // Manually trigger a catalog refresh. Builds adapters from configured API
  // keys and calls listModels() on each, then writes the merged catalog to
  // Redis. Intended for ops; the 6h cron does this automatically once deployed.
  app.post('/admin/ai-router/refresh-catalog', { config: { public: true } }, async (request, reply) => {
    if (!(await checkAdmin(request, reply))) return;
    try {
      const { refreshCatalog } = await import('../services/ai-router/catalog.js');
      const { getRedisClient } = await import('../services/redis.js');
      const { config } = await import('../config.js');
      const { openrouterAdapter } = await import('../services/ai-router/adapters/openrouter.js');
      // Provider-primary / provider-secondary adapters live in the cloud overlay;
      // OSS builds boot without them.
      let providerPrimaryAdapter: any = null;
      let providerSecondaryAdapter: any = null;
      let providerTertiaryAdapter: any = null;
      try {
        // @ts-expect-error — overlay path resolved at runtime
        const overlay = await import('../../../../cloud-overlays/dist/cloud-overlays/bootstrap.js');
        providerPrimaryAdapter = overlay.providerPrimaryAdapter;
        providerSecondaryAdapter = overlay.providerSecondaryAdapter;
        providerTertiaryAdapter = overlay.providerTertiaryAdapter;
      } catch { /* OSS mode */ }

      const adapters = [];
      if (config.aiRouter.openrouterApiKey) {
        adapters.push(openrouterAdapter({ apiKey: config.aiRouter.openrouterApiKey }));
      }
      if (providerPrimaryAdapter && config.aiRouter.providerPrimaryApiKey) {
        adapters.push(providerPrimaryAdapter({
          apiKey: config.aiRouter.providerPrimaryApiKey,
          baseUrl: config.aiRouter.providerPrimaryBaseUrl,
        }));
      }
      if (providerSecondaryAdapter && config.aiRouter.providerSecondaryApiKey) {
        adapters.push(providerSecondaryAdapter({
          apiKey: config.aiRouter.providerSecondaryApiKey,
          baseUrl: config.aiRouter.providerSecondaryBaseUrl,
          catalogUrl: config.aiRouter.providerSecondaryCatalogUrl,
        }));
      }
      if (providerTertiaryAdapter && config.aiRouter.providerTertiaryApiKey) {
        adapters.push(providerTertiaryAdapter({
          apiKey: config.aiRouter.providerTertiaryApiKey,
          baseUrl: config.aiRouter.providerTertiaryBaseUrl,
        }));
      }
      if (adapters.length === 0) {
        return reply.code(400).send({ error: 'no_adapters_configured' });
      }
      const result = await refreshCatalog(getRedisClient(), adapters);
      return {
        refreshed: true,
        modelCount: result.modelCount,
        lastRefreshedAt: result.lastRefreshedAt,
        routers: result.routers,
      };
    } catch (err) {
      app.log.error({ err }, 'admin: catalog refresh failed');
      return reply.code(500).send({
        error: 'refresh_failed',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // ───── GET /admin/ai-router/adapters ─────
  // Returns configured-status + last success/failure per router, aggregated
  // from ai_usage_logs across every runtime region. ai_usage_logs only logs
  // successful (settled) calls today, so "last_failure_at" is best-effort and
  // currently surfaces fallback_chain entries rather than terminal failures.
  app.get('/admin/ai-router/adapters', { config: { public: true } }, async (request, reply) => {
    if (!(await checkAdmin(request, reply))) return;
    const { config } = await import('../config.js');
    const adapters = [
      { name: 'openrouter', configured: !!config.aiRouter.openrouterApiKey },
      { name: 'provider-primary', configured: !!config.aiRouter.providerPrimaryApiKey },
      { name: 'provider-secondary', configured: !!config.aiRouter.providerSecondaryApiKey },
      { name: 'provider-tertiary', configured: !!config.aiRouter.providerTertiaryApiKey },
    ];
    // ai_usage_logs.router exists; rows are written only on settle so every row
    // is a "success". Treat the presence of any fallback_chain entry naming a
    // router as that router's most-recent failure timestamp.
    const successRows = await fanOutQuery<{ router: string; last_success: Date | null }>(
      `SELECT router, MAX(created_at) AS last_success
         FROM ai_usage_logs
        WHERE router IS NOT NULL
        GROUP BY router`,
    );
    const failureRows = await fanOutQuery<{ router_name: string; last_failure: Date | null }>(
      `SELECT (elem) AS router_name, MAX(created_at) AS last_failure
         FROM ai_usage_logs,
              LATERAL unnest(COALESCE(fallback_chain, ARRAY[]::text[])) AS elem
        WHERE elem IS NOT NULL
        GROUP BY elem`,
    );
    const successByRouter = new Map<string, Date | null>();
    for (const r of successRows) {
      const prev = successByRouter.get(r.router);
      const next = r.last_success;
      if (!prev || (next && next > prev)) successByRouter.set(r.router, next);
    }
    const failureByRouter = new Map<string, Date | null>();
    for (const r of failureRows) {
      // fallback_chain entries are of the form "router:reason"; the prefix is the router.
      const prefix = r.router_name.split(':')[0];
      const prev = failureByRouter.get(prefix);
      const next = r.last_failure;
      if (!prev || (next && next > prev)) failureByRouter.set(prefix, next);
    }
    return {
      adapters: adapters.map((a) => ({
        ...a,
        last_success_at: successByRouter.get(a.name) ?? null,
        last_failure_at: failureByRouter.get(a.name) ?? null,
      })),
    };
  });

  // ───── GET /admin/ai-router/insufficient-credits-stats ─────
  // Daily-bucketed counts of `ai_insufficient_credits` audit events over the
  // last N days (default 7, max 90), aggregated across runtime regions —
  // T16 writes these events to the runtime-plane audit_events table.
  app.get('/admin/ai-router/insufficient-credits-stats', { config: { public: true } }, async (request, reply) => {
    if (!(await checkAdmin(request, reply))) return;
    const { days } = (request.query as { days?: string }) ?? {};
    const d = Math.min(parseInt(days ?? '7', 10) || 7, 90);
    const rows = await fanOutQuery<{ date: string; count: string; unique_users: string }>(
      `SELECT DATE(created_at) AS date,
              COUNT(*)::text AS count,
              COUNT(DISTINCT actor_id)::text AS unique_users
         FROM audit_events
        WHERE event_type = 'ai_insufficient_credits'
          AND created_at >= NOW() - ($1 || ' days')::interval
        GROUP BY DATE(created_at)
        ORDER BY DATE(created_at)`,
      [String(d)],
    );
    // Merge per-day rows across regions (per-day unique_users is a lower bound
    // because we can't dedup actors across regions without a second query).
    const merged = new Map<string, { count: number; unique_users: number }>();
    for (const r of rows) {
      const k = String(r.date);
      const acc = merged.get(k) ?? { count: 0, unique_users: 0 };
      acc.count += parseInt(r.count, 10);
      acc.unique_users += parseInt(r.unique_users, 10);
      merged.set(k, acc);
    }
    return Array.from(merged.entries())
      .map(([date, v]) => ({ date, count: v.count, unique_users: v.unique_users }))
      .sort((a, b) => (a.date < b.date ? -1 : 1));
  });
}
