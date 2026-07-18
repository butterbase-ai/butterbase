// GET /admin/organizations — list endpoint.
//
// Reads exclusively from controlDb: organizations, organization_members,
// platform_users, org_app_index. No runtime-plane access needed (app_count
// comes from org_app_index, which lives in controlDb as of migration 090).
import type { FastifyPluginAsync } from 'fastify';
import { requireAdmin } from '../../lib/admin-guard.js';

function parseIntParam(value: string | undefined, fallback: number, max?: number): number {
  const raw = parseInt(value ?? '', 10);
  const n = (isNaN(raw) || raw <= 0) ? fallback : raw;
  return max ? Math.min(n, max) : n;
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

export interface AdminOrganizationRow {
  id: string;
  name: string;
  personal: boolean;
  owner_id: string;
  owner_email: string;
  plan_id: string | null;
  account_status: string;
  stripe_customer_id: string | null;
  credits_usd: number;
  monthly_allowance_usd: number;
  member_count: number;
  app_count: number;
  created_at: string;
}

const organizationsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/admin/organizations', { config: { public: true } }, async (req, reply) => {
    const user = await requireAdmin(req, reply, (fastify as any).controlDb, (fastify as any).authProvider);
    if (!user) return;

    const ctrl = (fastify as any).controlDb;
    const q = req.query as {
      search?: string; plan?: string; status?: string; personal?: string; has_stripe?: string;
      sort_by?: string; sort_dir?: string; limit?: string; offset?: string;
    };
    const limit = parseIntParam(q.limit, 50, 200);
    const offset = parseIntParam(q.offset, 0);

    const conds: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (q.search) {
      conds.push(`(o.name ILIKE $${idx} OR o.id::text ILIKE $${idx} OR pu.email ILIKE $${idx})`);
      params.push(`%${q.search}%`);
      idx++;
    }
    if (q.plan)   { conds.push(`o.plan_id = $${idx++}`);        params.push(q.plan); }
    if (q.status) { conds.push(`o.account_status = $${idx++}`); params.push(q.status); }
    if (q.personal === 'yes') conds.push(`o.personal = true`);
    if (q.personal === 'no')  conds.push(`o.personal = false`);
    if (q.has_stripe === 'yes') conds.push(`o.stripe_customer_id IS NOT NULL`);
    if (q.has_stripe === 'no')  conds.push(`o.stripe_customer_id IS NULL`);

    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const orderBy = buildOrderBy(q.sort_by, q.sort_dir, {
      created_at: 'o.created_at',
      name: 'o.name',
      plan_id: 'o.plan_id',
    }, 'ORDER BY o.created_at DESC');

    const controlRows = await ctrl.query(
      `SELECT o.id, o.name, o.personal, o.owner_id, pu.email AS owner_email,
              o.plan_id, o.account_status, o.stripe_customer_id,
              o.credits_usd::float8 AS credits_usd,
              coalesce(o.monthly_allowance_usd, 0)::float8 AS monthly_allowance_usd,
              o.created_at,
              (SELECT count(*)::int FROM organization_members m WHERE m.organization_id = o.id) AS member_count
       FROM organizations o
       JOIN platform_users pu ON pu.id = o.owner_id
       ${where}
       ${orderBy}`,
      params
    );

    const rows: any[] = controlRows.rows;
    if (rows.length === 0) return { data: [], total: 0 };

    const orgIds = rows.map((r) => r.id);

    // App count per org — org_app_index lives in controlDb (renamed from
    // user_app_index in migration 090), a single query, not a fanout.
    const appCountRows = await ctrl.query(
      `SELECT organization_id, count(*)::int AS app_count
         FROM org_app_index
        WHERE organization_id = ANY($1::uuid[])
        GROUP BY organization_id`,
      [orgIds]
    );
    const appCountByOrg = new Map<string, number>(
      appCountRows.rows.map((r: any) => [r.organization_id, r.app_count])
    );

    const merged: AdminOrganizationRow[] = rows.map((r) => ({
      ...r,
      app_count: appCountByOrg.get(r.id) ?? 0,
    }));

    return { data: merged.slice(offset, offset + limit), total: merged.length };
  });
};

export default organizationsRoutes;
