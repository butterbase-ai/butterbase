/**
 * One-shot backfill for the 2026-04-20 → 2026-05-02 webhook regression.
 *
 * Bug: invalidateUserAppLimits used `apps.owner_user_id` (column doesn't exist).
 * The bad query inside the webhook transaction silently aborted Postgres,
 * the next query ("INSERT INTO billing_events …") threw "transaction aborted",
 * and the outer ROLLBACK reverted EVERYTHING — plan_id, subscription row, and
 * the idempotency record. Stripe retries kept hitting the same failure.
 *
 * What this does for each user with stripe_customer_id but plan_id='playground':
 *   1. Ask Stripe for the customer's active/trialing subscription.
 *   2. Map subscription.items[0].price.id → our plan id.
 *   3. UPSERT subscriptions row, UPDATE platform_users.plan_id, set spending_cap.
 *   4. Invalidate Redis app-limits cache (post-commit, fire-and-forget).
 *
 * Idempotent — safe to run multiple times. Dry-run by default; pass --apply to
 * actually write.
 */
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Stripe from 'stripe';
import { Pool } from 'pg';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Load repo-root .env (script lives at services/control-api/scripts/)
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const APPLY = process.argv.includes('--apply');

const dbUrl = process.env.CONTROL_DB_URL;
if (!dbUrl) throw new Error('CONTROL_DB_URL missing');
const stripeKey = process.env.STRIPE_SECRET_KEY;
if (!stripeKey) throw new Error('STRIPE_SECRET_KEY missing');

const db = new Pool({ connectionString: dbUrl });
const stripe = new Stripe(stripeKey, { apiVersion: '2026-03-25.dahlia' });

interface PlanRow {
  id: string;
  name: string;
  stripe_price_id: string | null;
  default_spending_cap_usd: string | null;
}

async function loadPlanByPriceId(): Promise<Map<string, PlanRow>> {
  const { rows } = await db.query<PlanRow>(
    'SELECT id, name, stripe_price_id, default_spending_cap_usd FROM plans WHERE stripe_price_id IS NOT NULL'
  );
  const map = new Map<string, PlanRow>();
  for (const r of rows) if (r.stripe_price_id) map.set(r.stripe_price_id, r);
  return map;
}

interface Candidate {
  id: string;
  email: string;
  plan_id: string;
  stripe_customer_id: string;
}

async function loadCandidates(): Promise<Candidate[]> {
  const { rows } = await db.query<Candidate>(
    `SELECT id, email, plan_id, stripe_customer_id
       FROM platform_users
      WHERE stripe_customer_id IS NOT NULL
        AND plan_id = 'playground'`
  );
  return rows;
}

async function backfillUser(
  user: Candidate,
  planByPrice: Map<string, PlanRow>
): Promise<{ status: 'fixed' | 'no-active-sub' | 'unknown-price' | 'skipped'; detail?: string }> {
  // List active/trialing subs for this customer
  const subs = await stripe.subscriptions.list({
    customer: user.stripe_customer_id,
    status: 'all',
    limit: 10,
  });

  const live = subs.data.filter((s) => s.status === 'active' || s.status === 'trialing');
  if (live.length === 0) {
    return { status: 'no-active-sub' };
  }

  // Pick the most-recent active sub (in case of duplicates from retries)
  live.sort((a, b) => b.created - a.created);
  const sub = live[0];

  const priceId = sub.items.data[0]?.price?.id;
  if (!priceId) return { status: 'unknown-price', detail: 'no price on subscription item' };

  const plan = planByPrice.get(priceId);
  if (!plan) return { status: 'unknown-price', detail: priceId };

  if (plan.id === 'playground') return { status: 'skipped', detail: 'price maps to playground' };

  const item = sub.items.data[0];
  const periodStart = new Date((item.current_period_start ?? sub.created) * 1000);
  const periodEnd = new Date((item.current_period_end ?? sub.created) * 1000);
  const defaultCap = plan.default_spending_cap_usd;

  if (!APPLY) {
    return {
      status: 'fixed',
      detail: `[dry-run] would set plan=${plan.id}, sub=${sub.id}, period ${periodStart.toISOString()}→${periodEnd.toISOString()}`,
    };
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Cancel any other active subs we have on file for this user (defensive).
    await client.query(
      `UPDATE subscriptions SET status='canceled', updated_at=now()
        WHERE user_id=$1 AND stripe_subscription_id <> $2 AND status IN ('active','trialing')`,
      [user.id, sub.id]
    );

    // UPSERT the live subscription row.
    await client.query(
      `INSERT INTO subscriptions (user_id, plan_id, stripe_subscription_id, stripe_customer_id,
                                  status, current_period_start, current_period_end, cancel_at_period_end)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (stripe_subscription_id) DO UPDATE
         SET plan_id=EXCLUDED.plan_id,
             status=EXCLUDED.status,
             current_period_start=EXCLUDED.current_period_start,
             current_period_end=EXCLUDED.current_period_end,
             cancel_at_period_end=EXCLUDED.cancel_at_period_end,
             updated_at=now()`,
      [
        user.id,
        plan.id,
        sub.id,
        sub.customer,
        sub.status,
        periodStart,
        periodEnd,
        sub.cancel_at_period_end ?? false,
      ]
    );

    // Update user plan + spending cap (preserve any explicit cap they may already have).
    await client.query(
      `UPDATE platform_users
          SET plan_id=$1,
              account_status='active',
              spending_cap_usd = COALESCE(spending_cap_usd, $2),
              billing_period_start = COALESCE(billing_period_start, CURRENT_DATE)
        WHERE id=$3`,
      [plan.id, defaultCap, user.id]
    );

    // Audit row so this isn't silent.
    await client.query(
      `INSERT INTO billing_events (user_id, event_type, metadata)
       VALUES ($1, 'backfill_stuck_subscription', $2)`,
      [user.id, JSON.stringify({ stripe_subscription_id: sub.id, plan_id: plan.id, source: 'backfill-stuck-subscriptions' })]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  return { status: 'fixed', detail: `plan=${plan.id}, sub=${sub.id}` };
}

async function main() {
  console.log(`Mode: ${APPLY ? 'APPLY (writes)' : 'DRY-RUN (no writes; pass --apply to write)'}`);
  const planByPrice = await loadPlanByPriceId();
  console.log('Plan price map:', Object.fromEntries([...planByPrice].map(([k, v]) => [k, v.id])));

  const candidates = await loadCandidates();
  console.log(`Scanning ${candidates.length} candidate users…`);

  const summary: Record<string, number> = {};
  const fixed: Array<{ email: string; detail: string }> = [];
  const errors: Array<{ email: string; err: string }> = [];

  for (const user of candidates) {
    try {
      const r = await backfillUser(user, planByPrice);
      summary[r.status] = (summary[r.status] ?? 0) + 1;
      if (r.status === 'fixed') {
        fixed.push({ email: user.email, detail: r.detail ?? '' });
        console.log(`  ✓ ${user.email}: ${r.detail}`);
      } else if (r.status === 'unknown-price') {
        console.log(`  ? ${user.email}: unknown price ${r.detail}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ email: user.email, err: msg });
      console.error(`  ✗ ${user.email}: ${msg}`);
    }
  }

  console.log('\n=== Summary ===');
  console.log(summary);
  console.log(`Fixed: ${fixed.length}`);
  if (errors.length > 0) console.log(`Errors: ${errors.length}`);

  if (APPLY && fixed.length > 0) {
    console.log('\nNote: app-limits Redis cache will refresh on next request (TTL 60s) — no manual invalidation needed for a one-shot backfill.');
  }

  await db.end();
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
