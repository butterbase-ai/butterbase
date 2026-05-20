import type pg from 'pg';
import { resetCreditsEmailState } from './credits-email.js';

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
 * SET the user's monthly_allowance_usd to the plan's signup_credit_grant_usd.
 * Idempotent: the partial unique index on credit_grants (user_id) WHERE reason='signup'
 * guarantees at most one signup grant per user.
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
      throw new Error(`grantSignupCredits: plan ${args.planId} not found`);
    }
    const amount = parseFloat(plan.rows[0].signup_credit_grant_usd);
    if (amount <= 0) {
      await client.query('COMMIT');
      return { granted: 0 };
    }

    const ins = await client.query(
      `INSERT INTO credit_grants (user_id, plan_id, amount_usd, reason)
       VALUES ($1, $2, $3, 'signup')
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [args.userId, args.planId, amount]
    );
    if (ins.rows.length === 0) {
      await client.query('COMMIT');
      return { granted: 0 }; // already granted
    }

    await client.query(
      `UPDATE platform_users SET monthly_allowance_usd = $1 WHERE id = $2`,
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
  userId: string;
  amountUsd: number;
  stripeEventId: string;
}

/**
 * Add an auto-refill credit grant. Idempotent on stripe_event_id (the
 * PaymentIntent id) via the partial unique index on credit_grants.
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
      `INSERT INTO credit_grants (user_id, plan_id, amount_usd, reason, stripe_event_id)
       VALUES ($1, NULL, $2, 'auto_refill', $3)
       ON CONFLICT (stripe_event_id) DO NOTHING
       RETURNING id`,
      [args.userId, args.amountUsd, args.stripeEventId]
    );
    if (ins.rows.length === 0) {
      await client.query('COMMIT');
      return { granted: 0 };
    }
    await client.query(
      `UPDATE platform_users SET credits_usd = credits_usd + $1 WHERE id = $2`,
      [args.amountUsd, args.userId]
    );
    await client.query('COMMIT');
    await resetCreditsEmailState(pool, args.userId);
    return { granted: args.amountUsd };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
