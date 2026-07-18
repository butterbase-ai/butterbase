// GET /admin/organizations — list endpoint.
//
// Reads exclusively from controlDb: organizations, organization_members,
// platform_users, org_app_index. No runtime-plane access needed (app_count
// comes from org_app_index, which lives in controlDb as of migration 090).
import type { FastifyPluginAsync } from 'fastify';
import { requireAdmin } from '../../lib/admin-guard.js';
import { fanOutQuery } from '../../services/region-resolver.js';

// Stripe client lives in the cloud overlay; OSS builds reach an explicit
// failure. Kept here rather than at module scope so a bad build in overlays
// only fails routes that need Stripe (this handler), not the whole plugin.
//
// Compiled path is services/control-api/dist/routes/admin/organizations.js
// (one directory deeper than routes/admin.js, so one extra `..`), and the
// production layout after the platform Dockerfile is /app/cloud/overlays/...
// (not /app/cloud-overlays/... — that hyphenated shape is a stale string in
// routes/admin.ts's copy of this helper; keep it consistent here with what
// the platform image actually ships).
async function getStripeClient(): Promise<any> {
  // @ts-expect-error — overlay path resolved at runtime
  const mod = await import('../../../../../../cloud/overlays/dist/cloud/overlays/billing/stripe/stripe-service.js');
  return mod.getStripeClient();
}

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

  // PATCH /admin/organizations/:id/plan
  //
  // Assigns a plan to an org and — when the org has a live Stripe subscription
  // AND the caller supplied a stripe_price_id — actually pushes the price
  // change to Stripe. Mirrors the per-user assignEnterprisePriceToUser flow
  // (cloud-overlays/billing/enterprise/assign-to-user.ts) but keyed on
  // organization_id, so team-org enterprise pricing has a real code path.
  //
  // Sequence:
  //   1. Validate inputs, load org + existing subscription + plan.
  //   2. If Stripe is in play (live sub + new price_id): retrieve, sanity-
  //      check, update the subscription item price with proration_behavior
  //      'none' — cycle dates unchanged, no mid-cycle proration. Void any
  //      open invoices on the sub to stop Stripe smart-retry from clobbering
  //      the assignment via a payment_failed webhook.
  //   3. DB transaction: update org.plan_id, upsert the subscriptions row
  //      (persisting stripe_price_id when set), audit to billing_events.
  //
  // On Stripe-then-DB failure the caller can safely retry: currentPriceId
  // will match the input on retry → noop branch; already-voided invoices are
  // filtered out of the list; the DB writes are idempotent by shape.
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

    const orgRes = await ctrl.query(
      `SELECT id, owner_id, plan_id, stripe_customer_id, account_status
         FROM organizations WHERE id = $1`,
      [id]
    );
    if (orgRes.rows.length === 0) {
      reply.code(404).send({ error: 'organization_not_found' });
      return;
    }
    const org = orgRes.rows[0] as {
      id: string; owner_id: string; plan_id: string | null;
      stripe_customer_id: string | null; account_status: string;
    };

    // Existing live subscription for this org (any non-canceled state — we
    // rescue past_due/unpaid users too, matching the per-user flow's intent).
    const subRes = await ctrl.query(
      `SELECT id, user_id, stripe_subscription_id, plan_id, stripe_price_id, status
         FROM subscriptions
        WHERE organization_id = $1
          AND status IN ('active', 'trialing', 'past_due', 'unpaid', 'incomplete')
        ORDER BY updated_at DESC`,
      [id]
    );
    if (subRes.rows.length > 1) {
      reply.code(409).send({
        error: 'multiple_active_subs',
        subscription_ids: subRes.rows.map((r: any) => r.stripe_subscription_id),
      });
      return;
    }
    const existingSub = subRes.rows[0] as {
      id: string; user_id: string; stripe_subscription_id: string | null;
      plan_id: string; stripe_price_id: string | null; status: string;
    } | undefined;

    // Decide whether we're driving Stripe or DB-only. Stripe needs the
    // org's customer id, a live subscription with a stripe_subscription_id,
    // and a stripe_price_id from the caller. Without any one of those, we
    // fall back to a DB-only assignment (still useful — e.g. sliding a
    // Stripe-less org onto 'playground', or shipping the plan change ahead
    // of Stripe setup).
    const stripeInPlay = Boolean(
      stripe_price_id && existingSub?.stripe_subscription_id && org.stripe_customer_id
    );

    let stripeContext: {
      currentPriceId: string;
      subscriptionItemId: string;
      newUnitAmountCents: number;
      voidedInvoices: Array<{ id: string; amount_due_cents: number; status_before: string }>;
      idempotentNoop: boolean;
    } | null = null;

    if (stripeInPlay) {
      const stripe = await getStripeClient();
      const stripeSub = await stripe.subscriptions.retrieve(existingSub!.stripe_subscription_id!);
      const subCustomerId = typeof stripeSub.customer === 'string'
        ? stripeSub.customer
        : stripeSub.customer.id;
      if (subCustomerId !== org.stripe_customer_id) {
        reply.code(409).send({ error: 'stripe_customer_mismatch' });
        return;
      }
      if (stripeSub.items.data.length !== 1) {
        reply.code(409).send({
          error: 'multiple_subscription_items',
          count: stripeSub.items.data.length,
        });
        return;
      }
      const item = stripeSub.items.data[0];
      const currentPriceId: string = item.price.id;

      const targetPrice = await stripe.prices.retrieve(stripe_price_id!, { expand: ['product'] });
      if (!targetPrice.active) {
        reply.code(400).send({ error: 'price_inactive' });
        return;
      }
      if (!targetPrice.recurring) {
        reply.code(400).send({ error: 'price_not_recurring' });
        return;
      }
      // Sanity: the price's product should be tagged for the target plan.
      // We skip the check when the price's product has no butterbase_plan_id
      // (older prices predate the tagging) to stay backward-compatible.
      const productPlanTag = (targetPrice.product as any)?.metadata?.butterbase_plan_id;
      if (productPlanTag && productPlanTag !== plan_id) {
        reply.code(400).send({
          error: 'price_plan_mismatch',
          expected_plan_id: plan_id,
          price_plan_id: productPlanTag,
        });
        return;
      }

      const idempotentNoop = currentPriceId === stripe_price_id && org.plan_id === plan_id;

      const voidedInvoices: Array<{ id: string; amount_due_cents: number; status_before: string }> = [];
      if (!idempotentNoop && currentPriceId !== stripe_price_id) {
        // Cycle dates untouched; no mid-cycle proration. Next invoice at the
        // normal boundary uses the new price for the whole period.
        await stripe.subscriptionItems.update(item.id, {
          price: stripe_price_id,
          proration_behavior: 'none',
        });

        // Void open invoices to stop Stripe's ~3-week smart-retry from
        // clobbering the assignment via payment_failed webhooks. This is a
        // deliberate write-off — for the rescue/enterprise case it's what
        // the operator wants.
        const openInvoices = await stripe.invoices.list({
          customer: org.stripe_customer_id!,
          status: 'open',
          subscription: stripeSub.id,
          limit: 100,
        });
        for (const inv of openInvoices.data) {
          if (!inv.id) continue;
          try {
            await stripe.invoices.voidInvoice(inv.id);
            voidedInvoices.push({
              id: inv.id,
              amount_due_cents: inv.amount_due ?? 0,
              status_before: inv.status ?? 'unknown',
            });
          } catch (err) {
            // Invoice may have paid or transitioned; log and continue rather
            // than aborting the whole assignment for a stale-state void.
            req.log?.warn?.(
              { err, invoice_id: inv.id, subscription_id: stripeSub.id },
              'org-plan-assign: failed to void invoice'
            );
          }
        }
      }

      stripeContext = {
        currentPriceId,
        subscriptionItemId: item.id,
        newUnitAmountCents: targetPrice.unit_amount ?? 0,
        voidedInvoices,
        idempotentNoop,
      };
    }

    // DB writes. One transaction so the org, subscription and audit rows
    // either all land or none. user_state_outbox is written inside the same
    // transaction so plan_id propagation stays paired with the plan change.
    const client = await ctrl.connect();
    try {
      await client.query('BEGIN');

      // Serialize concurrent admin plan changes for the same org.
      if (existingSub) {
        await client.query(`SELECT id FROM subscriptions WHERE id = $1 FOR UPDATE`, [existingSub.id]);
      }

      const updOrg = await client.query(
        `UPDATE organizations SET plan_id = $1, updated_at = now() WHERE id = $2
         RETURNING id, plan_id, account_status`,
        [plan_id, id]
      );
      // rowCount 0 shouldn't happen — we just SELECTed the org outside the
      // tx, and org rows aren't hard-deleted. But guard anyway.
      if (updOrg.rows.length === 0) {
        await client.query('ROLLBACK');
        reply.code(404).send({ error: 'organization_not_found' });
        return;
      }

      // Paired user_state_outbox row so the plan_id change propagates to
      // downstream consumers (app-plan-resolver, etc.), same as the
      // per-user flow. anchored to the org owner as user_id.
      await client.query(
        `INSERT INTO user_state_outbox (user_id, organization_id, fields_changed)
         VALUES ($1, $2, $3::jsonb)`,
        [org.owner_id, id, JSON.stringify({ plan_id })]
      );

      if (!existingSub) {
        await client.query(
          `INSERT INTO subscriptions (user_id, organization_id, plan_id, status, stripe_price_id, created_at)
           VALUES ($1, $2, $3, 'active', $4, now())`,
          [org.owner_id, id, plan_id, stripe_price_id ?? null]
        );
      } else {
        // Clear grace_period_ends_at so the nightly enforceExpiredGracePeriods
        // cron doesn't clobber this assignment — same reason the per-user
        // flow clears it.
        await client.query(
          `UPDATE subscriptions
              SET plan_id = $1,
                  stripe_price_id = coalesce($2, stripe_price_id),
                  status = 'active',
                  grace_period_ends_at = NULL,
                  updated_at = now()
            WHERE id = $3`,
          [plan_id, stripe_price_id ?? null, existingSub.id]
        );
      }

      await client.query(
        `INSERT INTO billing_events (user_id, organization_id, event_type, metadata, created_at)
         VALUES ($1, $2, 'plan_assigned_admin', $3::jsonb, now())`,
        [
          user.id,
          id,
          JSON.stringify({
            from_plan: org.plan_id,
            to_plan: plan_id,
            stripe_price_id: stripe_price_id ?? null,
            stripe_subscription_id: existingSub?.stripe_subscription_id ?? null,
            stripe_in_play: stripeInPlay,
            stripe_noop: stripeContext?.idempotentNoop ?? false,
            old_stripe_price_id: stripeContext?.currentPriceId ?? null,
            new_unit_amount_cents: stripeContext?.newUnitAmountCents ?? null,
            voided_invoices: stripeContext?.voidedInvoices ?? [],
            actor_admin_id: user.id,
            actor_admin_email: user.email,
          }),
        ]
      );

      await client.query('COMMIT');
      reply.send({ organization: updOrg.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });
};

export default organizationsRoutes;
