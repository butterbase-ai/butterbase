import type pg from 'pg';
import { resetCreditsEmailState } from './credits-email.js';
import { NotFoundError } from './api-errors.js';

export interface SignupGrantArgs {
  userId: string;
  planId: string;
}

export interface GrantResult {
  granted: number; // 0 when no-op (idempotent or zero-amount plan)
}

export interface CreditGrantRow {
  id: string;
  user_id: string;
  plan_id: string | null;
  amount_usd: number;
  reason: 'signup' | 'auto_refill' | 'manual' | 'refund';
  stripe_event_id: string | null;
  created_at: Date;
}

/**
 * Add the plan's signup_credit_grant_usd to the user's credits_usd (topup) pool.
 * The topup pool survives plan upgrades and monthly resets, giving the grant true
 * lifetime semantics. Idempotent: the partial unique index on credit_grants
 * (user_id) WHERE reason='signup' guarantees at most one signup grant per user.
 */
export async function grantSignupCredits(
  pool: pg.Pool,
  args: SignupGrantArgs
): Promise<GrantResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const plan = await client.query<{ signup_credit_grant_usd: string }>(
      `SELECT signup_credit_grant_usd FROM plans WHERE id = $1`,
      [args.planId]
    );
    if (plan.rows.length === 0) {
      await client.query('ROLLBACK');
      throw new NotFoundError('plan', args.planId);
    }
    const amount = parseFloat(plan.rows[0].signup_credit_grant_usd);
    if (amount <= 0) {
      await client.query('COMMIT');
      return { granted: 0 };
    }

    const ins = await client.query(
      `INSERT INTO credit_grants (user_id, organization_id, plan_id, amount_usd, reason)
       VALUES ($1, (SELECT personal_organization_id FROM platform_users WHERE id = $1), $2, $3, 'signup')
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [args.userId, args.planId, amount]
    );
    if (ins.rows.length === 0) {
      await client.query('COMMIT');
      return { granted: 0 }; // already granted
    }

    await client.query(
      `UPDATE organizations SET credits_usd = credits_usd + $1 WHERE id = (SELECT personal_organization_id FROM platform_users WHERE id = $2)`,
      [amount, args.userId]
    );

    await client.query('COMMIT');
    await resetCreditsEmailState(pool, args.userId);
    return { granted: amount };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function getCreditGrants(
  pool: pg.Pool,
  userId: string,
  limit: number
): Promise<CreditGrantRow[]> {
  const res = await pool.query<CreditGrantRow>(
    `SELECT id, user_id, plan_id, amount_usd::float AS amount_usd, reason, stripe_event_id, created_at
     FROM credit_grants
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [userId, limit]
  );
  return res.rows;
}

export interface AutoRefillGrantArgs {
  organizationId: string;
  amountUsd: number;
  stripeEventId: string;
}

/**
 * Add an auto-refill credit grant against a specific org (personal OR team).
 * Idempotent on stripe_event_id (the PaymentIntent id) via the partial unique
 * index on credit_grants.
 *
 * Records the org's owner_id in credit_grants.user_id for provenance so the
 * ledger still surfaces "who was charged" for personal orgs. Team-org grants
 * carry the org's owner_id — which is the account holder that authorized the
 * card on that org's Stripe Customer.
 */
export async function grantAutoRefillCredits(
  pool: pg.Pool,
  args: AutoRefillGrantArgs
): Promise<GrantResult> {
  if (args.amountUsd <= 0) return { granted: 0 };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ins = await client.query(
      `INSERT INTO credit_grants (user_id, organization_id, plan_id, amount_usd, reason, stripe_event_id)
       SELECT o.owner_id, o.id, NULL, $2, 'auto_refill', $3
         FROM organizations o
        WHERE o.id = $1
       ON CONFLICT (stripe_event_id) WHERE stripe_event_id IS NOT NULL DO NOTHING
       RETURNING user_id AS owner_id`,
      [args.organizationId, args.amountUsd, args.stripeEventId]
    );
    if (ins.rows.length === 0) {
      await client.query('COMMIT');
      return { granted: 0 };
    }
    const ownerId = ins.rows[0].owner_id as string;
    await client.query(
      `UPDATE organizations SET credits_usd = credits_usd + $1 WHERE id = $2`,
      [args.amountUsd, args.organizationId]
    );
    await client.query('COMMIT');
    // Reset the credits-email debounce for the org owner (who was charged).
    await resetCreditsEmailState(pool, ownerId);
    return { granted: args.amountUsd };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
