import type pg from 'pg';
import { resolveOrganizationId } from './org-resolver.js';

export interface ResetArgs {
  userId: string;
  planId: string;
  stripeEventId: string;
}

export interface ResetResult {
  newAmount: number;
  previousUnspent: number;
  skippedDuplicate?: boolean;
}

/**
 * SET platform_users.monthly_allowance_usd to plans.monthly_credit_grant_usd.
 * Use-it-or-lose-it: any unspent amount is recorded in monthly_credit_resets
 * (previous_unspent_usd) and then overwritten.
 *
 * Idempotent on stripe_event_id via the partial unique index. If the index
 * conflicts, returns { skippedDuplicate: true, newAmount: <current>, previousUnspent: <current> }
 * without writing anything.
 *
 * Caller-owned-transaction variant — used by stripe-service.handleInvoicePaid
 * which runs the webhook inside a single transaction.
 */
export async function resetMonthlyAllowanceWithClient(
  pool: pg.Pool,
  client: pg.PoolClient,
  args: ResetArgs
): Promise<ResetResult> {
  const plan = await client.query<{ monthly_credit_grant_usd: string }>(
    `SELECT monthly_credit_grant_usd FROM plans WHERE id = $1`,
    [args.planId]
  );
  if (plan.rows.length === 0) {
    throw new Error(`resetMonthlyAllowance: plan ${args.planId} not found`);
  }
  const grantAmount = parseFloat(plan.rows[0].monthly_credit_grant_usd);

  const userRow = await client.query<{ monthly_allowance_usd: string }>(
    `SELECT monthly_allowance_usd FROM platform_users WHERE id = $1 FOR UPDATE`,
    [args.userId]
  );
  if (userRow.rows.length === 0) {
    throw new Error(`resetMonthlyAllowance: user ${args.userId} not found`);
  }
  const previousUnspent = parseFloat(userRow.rows[0].monthly_allowance_usd);

  const organizationId = await resolveOrganizationId(pool, args.userId);
  const insRes = await client.query(
    `INSERT INTO monthly_credit_resets (user_id, organization_id, plan_id, amount_usd, previous_unspent_usd, stripe_event_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (stripe_event_id) WHERE stripe_event_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [args.userId, organizationId, args.planId, grantAmount, previousUnspent, args.stripeEventId]
  );
  if (insRes.rows.length === 0) {
    // Duplicate event — already processed. Don't touch monthly_allowance.
    return { newAmount: previousUnspent, previousUnspent, skippedDuplicate: true };
  }

  // SET — not add. Use-it-or-lose-it.
  await client.query(
    `UPDATE platform_users SET monthly_allowance_usd = $1 WHERE id = $2`,
    [grantAmount, args.userId]
  );

  // Balance was just bumped — clear the credits-email dedup state so the next
  // time the balance drops we re-warn. Inline (not via resetCreditsEmailState)
  // to stay inside the caller-owned transaction.
  await client.query(
    `UPDATE platform_users
        SET credits_low_emailed_at = NULL,
            credits_exhausted_emailed_at = NULL
      WHERE id = $1
        AND (credits_low_emailed_at IS NOT NULL OR credits_exhausted_emailed_at IS NOT NULL)`,
    [args.userId]
  );

  return { newAmount: grantAmount, previousUnspent };
}

/**
 * Pool-owning variant: opens its own connection + transaction. For direct
 * callers (tests, future admin tools).
 */
export async function resetMonthlyAllowance(
  pool: pg.Pool,
  args: ResetArgs
): Promise<ResetResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await resetMonthlyAllowanceWithClient(pool, client, args);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
