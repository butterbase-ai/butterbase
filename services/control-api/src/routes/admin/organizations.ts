// GET /admin/organizations — list endpoint.
//
// Reads exclusively from controlDb: organizations, organization_members,
// platform_users, org_app_index. No runtime-plane access needed (app_count
// comes from org_app_index, which lives in controlDb as of migration 090).
import type { FastifyPluginAsync } from 'fastify';
import { requireAdmin } from '../../lib/admin-guard.js';
import { fanOutQuery } from '../../services/region-resolver.js';

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

export interface AdminOrganizationDetail {
  org: AdminOrganizationRow & {
    auto_refill_enabled: boolean;
    auto_refill_amount_usd: number | null;
    billing_period_start: string | null;
  };
  members: Array<{
    user_id: string;
    email: string;
    display_name: string | null;
    role: 'owner' | 'member';
    invited_by: string | null;
    joined_at: string;
  }>;
  apps: Array<{
    id: string;
    name: string;
    region: string;
    owner_id: string;
    db_provisioned: boolean;
    deployment_url: string | null;
    last_deployed_at: string | null;
    created_at: string;
  }>;
  subscription: {
    plan_id: string;
    plan_name: string;
    status: string;
    price_monthly_cents: number;
    started_at: string;
  } | null;
  recentBillingEvents: Array<{
    id: string;
    event_type: string;
    created_at: string;
  }>;
  creditsLedger: {
    credits_usd: number;
    monthly_allowance_usd: number;
    auto_refill_enabled: boolean;
    auto_refill_amount_usd: number | null;
    auto_refill_last_attempt_at: string | null;
    auto_refill_last_failure_reason: string | null;
  };
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

    const MAX_LIST_OFFSET = 1000;
    if (offset >= MAX_LIST_OFFSET) {
      reply.code(400).send({
        error: 'offset_too_large',
        message: `Pagination offset must be < ${MAX_LIST_OFFSET}. Use search/filter params to narrow.`,
      });
      return;
    }

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

    // Cap the fetch instead of pulling every matching org row — the admin
    // dashboard only ever renders one page at a time. `total` below reflects
    // the number of rows actually fetched, so for result sets larger than
    // 1000 it will under-report the true total; that's an accepted tradeoff
    // for the admin surface (see whole-branch review, Important finding 7).
    const fetchCap = Math.min(limit + offset, 1000);
    const fetchLimitIdx = idx++;
    params.push(fetchCap);

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
       ${orderBy}
       LIMIT $${fetchLimitIdx}`,
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

  fastify.get('/admin/organizations/:id', { config: { public: true } }, async (req, reply) => {
    const user = await requireAdmin(req, reply, (fastify as any).controlDb, (fastify as any).authProvider);
    if (!user) return;

    const ctrl = (fastify as any).controlDb;
    const { id } = req.params as { id: string };

    const orgRes = await ctrl.query(
      `SELECT o.id, o.name, o.personal, o.owner_id, pu.email AS owner_email,
              o.plan_id, o.account_status, o.stripe_customer_id,
              o.credits_usd::float8 AS credits_usd,
              coalesce(o.monthly_allowance_usd, 0)::float8 AS monthly_allowance_usd,
              o.auto_refill_enabled,
              o.auto_refill_amount_usd::float8 AS auto_refill_amount_usd,
              o.auto_refill_last_attempt_at, o.auto_refill_last_failure_reason,
              o.billing_period_start, o.created_at
         FROM organizations o
         JOIN platform_users pu ON pu.id = o.owner_id
        WHERE o.id = $1`,
      [id]
    );
    if (orgRes.rows.length === 0) {
      reply.code(404).send({ error: 'organization_not_found' });
      return;
    }
    const org = orgRes.rows[0];

    const [membersRes, appIndexRes, subRes, eventsRes] = await Promise.all([
      ctrl.query(
        `SELECT m.user_id, pu.email, pu.display_name, m.role, m.invited_by, m.joined_at
           FROM organization_members m
           JOIN platform_users pu ON pu.id = m.user_id
          WHERE m.organization_id = $1
          ORDER BY m.role = 'owner' DESC, m.joined_at ASC`,
        [id]
      ),
      ctrl.query(
        `SELECT app_id, region FROM org_app_index WHERE organization_id = $1 ORDER BY created_at DESC`,
        [id]
      ),
      ctrl.query(
        `SELECT s.plan_id, p.name AS plan_name, s.status,
                coalesce(p.price_monthly_cents, 0) AS price_monthly_cents,
                s.created_at AS started_at
           FROM subscriptions s
           LEFT JOIN plans p ON p.id = s.plan_id
          WHERE s.organization_id = $1
          ORDER BY s.created_at DESC
          LIMIT 1`,
        [id]
      ),
      ctrl.query(
        `SELECT id, event_type, created_at
           FROM billing_events
          WHERE organization_id = $1
          ORDER BY created_at DESC
          LIMIT 25`,
        [id]
      ),
    ]);

    const indexRows: Array<{ app_id: string; region: string }> = appIndexRes.rows;
    const apps = indexRows.length === 0
      ? []
      : await fanOutQuery<any>(
          `SELECT id, name, region, owner_id, db_provisioned, deployment_url,
                  last_deployed_at, created_at
             FROM apps
            WHERE id = ANY($1::text[])`,
          [indexRows.map((r) => r.app_id)]
        );

    const detail: AdminOrganizationDetail = {
      org: { ...org, member_count: membersRes.rows.length, app_count: apps.length },
      members: membersRes.rows,
      apps,
      subscription: subRes.rows[0] ?? null,
      recentBillingEvents: eventsRes.rows,
      creditsLedger: {
        credits_usd: org.credits_usd,
        monthly_allowance_usd: org.monthly_allowance_usd,
        auto_refill_enabled: org.auto_refill_enabled,
        auto_refill_amount_usd: org.auto_refill_amount_usd,
        auto_refill_last_attempt_at: org.auto_refill_last_attempt_at,
        auto_refill_last_failure_reason: org.auto_refill_last_failure_reason,
      },
    };
    return detail;
  });

  fastify.post('/admin/organizations/:id/members', { config: { public: true } }, async (req, reply) => {
    const user = await requireAdmin(req, reply, (fastify as any).controlDb, (fastify as any).authProvider);
    if (!user) return;

    const ctrl = (fastify as any).controlDb;
    const { id } = req.params as { id: string };
    const { user_id, role } = (req.body ?? {}) as { user_id?: string; role?: 'owner' | 'member' };

    if (!user_id) {
      reply.code(400).send({ error: 'user_id_required' });
      return;
    }

    if (role !== 'owner' && role !== 'member') {
      reply.code(400).send({ error: 'invalid_role' });
      return;
    }

    const orgRes = await ctrl.query(`SELECT 1 FROM organizations WHERE id = $1`, [id]);
    if (orgRes.rows.length === 0) {
      reply.code(404).send({ error: 'organization_not_found' });
      return;
    }

    const userRes = await ctrl.query(`SELECT 1 FROM platform_users WHERE id = $1`, [user_id]);
    if (userRes.rows.length === 0) {
      reply.code(404).send({ error: 'user_not_found' });
      return;
    }

    const inserted = await ctrl.query(
      `WITH upserted AS (
         INSERT INTO organization_members (organization_id, user_id, role, invited_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (organization_id, user_id) DO UPDATE SET role = EXCLUDED.role
         RETURNING organization_id, user_id, role, invited_by, joined_at
       )
       SELECT u.organization_id, u.user_id, u.role, u.invited_by, u.joined_at,
              pu.email, pu.display_name
         FROM upserted u
         JOIN platform_users pu ON pu.id = u.user_id`,
      [id, user_id, role, user.id]
    );
    reply.code(201).send({ member: inserted.rows[0] });
  });

  fastify.patch('/admin/organizations/:id/members/:user_id', { config: { public: true } }, async (req, reply) => {
    const user = await requireAdmin(req, reply, (fastify as any).controlDb, (fastify as any).authProvider);
    if (!user) return;

    const ctrl = (fastify as any).controlDb;
    const { id, user_id } = req.params as { id: string; user_id: string };
    const { role } = (req.body ?? {}) as { role?: 'owner' | 'member' };

    if (role !== 'owner' && role !== 'member') {
      reply.code(400).send({ error: 'invalid_role' });
      return;
    }

    const orgRes = await ctrl.query(`SELECT 1 FROM organizations WHERE id = $1`, [id]);
    if (orgRes.rows.length === 0) {
      reply.code(404).send({ error: 'organization_not_found' });
      return;
    }

    const client = await ctrl.connect();
    try {
      await client.query('BEGIN');

      const updRes = await client.query(
        `UPDATE organization_members SET role = $1
          WHERE organization_id = $2 AND user_id = $3
          RETURNING organization_id, user_id, role, invited_by, joined_at`,
        [role, id, user_id]
      );
      if (updRes.rows.length === 0) {
        await client.query('ROLLBACK');
        reply.code(404).send({ error: 'member_not_found' });
        return;
      }

      if (role === 'member') {
        // FOR UPDATE serializes concurrent admins racing the same org's
        // owner count, closing the demote-then-delete last-owner race.
        const ownersRes = await client.query(
          `SELECT count(*)::int AS c FROM organization_members
            WHERE organization_id = $1 AND role = 'owner' FOR UPDATE`,
          [id]
        );
        if (ownersRes.rows[0].c === 0) {
          await client.query('ROLLBACK');
          reply.code(400).send({ error: 'last_owner' });
          return;
        }
      }

      const finalRes = await client.query(
        `SELECT m.organization_id, m.user_id, m.role, m.invited_by, m.joined_at,
                pu.email, pu.display_name
           FROM organization_members m
           JOIN platform_users pu ON pu.id = m.user_id
          WHERE m.organization_id = $1 AND m.user_id = $2`,
        [id, user_id]
      );

      await client.query('COMMIT');
      reply.send({ member: finalRes.rows[0] });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      if (err?.code === '40P01') {
        reply.code(409).send({ error: 'concurrent_modification', message: 'Another admin is modifying this organization. Please retry.' });
        return;
      }
      throw err;
    } finally {
      client.release();
    }
  });

  fastify.delete('/admin/organizations/:id/members/:user_id', { config: { public: true } }, async (req, reply) => {
    const user = await requireAdmin(req, reply, (fastify as any).controlDb, (fastify as any).authProvider);
    if (!user) return;

    const ctrl = (fastify as any).controlDb;
    const { id, user_id } = req.params as { id: string; user_id: string };

    const client = await ctrl.connect();
    try {
      await client.query('BEGIN');

      // FOR UPDATE holds the row lock across the owner-count check and the
      // delete, closing the race where two concurrent deletes both see >1
      // owner and both proceed, leaving the org with zero owners.
      const targetRes = await client.query(
        `SELECT role FROM organization_members
          WHERE organization_id = $1 AND user_id = $2 FOR UPDATE`,
        [id, user_id]
      );
      if (targetRes.rows.length === 0) {
        await client.query('ROLLBACK');
        reply.code(404).send({ error: 'member_not_found' });
        return;
      }

      if (targetRes.rows[0].role === 'owner') {
        const ownersRes = await client.query(
          `SELECT count(*)::int AS c FROM organization_members
            WHERE organization_id = $1 AND role = 'owner' FOR UPDATE`,
          [id]
        );
        if (ownersRes.rows[0].c <= 1) {
          await client.query('ROLLBACK');
          reply.code(400).send({ error: 'last_owner' });
          return;
        }
      }

      await client.query(
        `DELETE FROM organization_members WHERE organization_id = $1 AND user_id = $2`,
        [id, user_id]
      );
      await client.query('COMMIT');
      reply.code(204).send();
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      if (err?.code === '40P01') {
        reply.code(409).send({ error: 'concurrent_modification', message: 'Another admin is modifying this organization. Please retry.' });
        return;
      }
      throw err;
    } finally {
      client.release();
    }
  });

  fastify.patch('/admin/organizations/:id/plan', { config: { public: true } }, async (req, reply) => {
    const user = await requireAdmin(req, reply, (fastify as any).controlDb, (fastify as any).authProvider);
    if (!user) return;

    const ctrl = (fastify as any).controlDb;
    const { id } = req.params as { id: string };
    const { plan_id, stripe_price_id } = (req.body ?? {}) as { plan_id?: string; stripe_price_id?: string };

    if (!plan_id) {
      reply.code(400).send({ error: 'plan_id_required' });
      return;
    }

    const planRes = await ctrl.query(`SELECT id FROM plans WHERE id = $1`, [plan_id]);
    if (planRes.rows.length === 0) {
      reply.code(404).send({ error: 'plan_not_found' });
      return;
    }

    const client = await ctrl.connect();
    try {
      await client.query('BEGIN');

      const updRes = await client.query(
        `UPDATE organizations SET plan_id = $1, updated_at = now() WHERE id = $2
         RETURNING id, plan_id, account_status`,
        [plan_id, id]
      );
      if (updRes.rows.length === 0) {
        await client.query('ROLLBACK');
        reply.code(404).send({ error: 'organization_not_found' });
        return;
      }

      // Upsert subscription row keyed on organization_id. subscriptions.organization_id
      // has no UNIQUE constraint (migration 075 only added the column), so ON CONFLICT
      // isn't available here — do a manual SELECT then UPDATE-or-INSERT. FOR UPDATE
      // serializes concurrent admins racing a plan change for the same org.
      //
      // subscriptions has no stripe_price_id column — the picked enterprise price is
      // captured in the billing_events audit metadata below. subscriptions.user_id is
      // NOT NULL; for a fresh INSERT we anchor it to the org owner.
      const existingSub = await client.query(
        `SELECT id FROM subscriptions WHERE organization_id = $1 LIMIT 1 FOR UPDATE`,
        [id]
      );
      if (existingSub.rows.length === 0) {
        const ownerRes = await client.query(
          `SELECT owner_id FROM organizations WHERE id = $1`,
          [id]
        );
        const ownerId = ownerRes.rows[0]?.owner_id;
        if (!ownerId) {
          await client.query('ROLLBACK');
          reply.code(500).send({ error: 'organization_owner_not_found' });
          return;
        }
        await client.query(
          `INSERT INTO subscriptions (user_id, organization_id, plan_id, status, created_at)
           VALUES ($1, $2, $3, 'active', now())`,
          [ownerId, id, plan_id]
        );
      } else {
        await client.query(
          `UPDATE subscriptions
              SET plan_id = $1,
                  status = 'active',
                  updated_at = now()
            WHERE organization_id = $2`,
          [plan_id, id]
        );
      }

      await client.query(
        `INSERT INTO billing_events (user_id, organization_id, event_type, metadata, created_at)
         VALUES ($1, $2, 'plan_assigned_admin', $3::jsonb, now())`,
        [user.id, id, JSON.stringify({ plan_id, stripe_price_id: stripe_price_id ?? null })]
      );

      await client.query('COMMIT');
      reply.send({ organization: updRes.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });
};

export default organizationsRoutes;
