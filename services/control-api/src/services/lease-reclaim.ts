import type pg from 'pg';
import { MIN_LEASE_USD } from './ai-router/billing-gate.js';

export interface ReclaimResult {
  /** Leases that were actually refunded and marked 'reclaimed'. */
  reclaimed: number;
  /** Nominal leases marked 'abandoned' — no refund, still settleable later. */
  abandoned: number;
  totalCreditedUsd: number;
}

/**
 * Sweep expired leases. The decision is made PER LEASE, never on a global
 * flag: a lease of MIN_LEASE_USD or less is a nominal reserve-small hold with
 * nothing worth refunding, and its job may still complete and must still bill
 * — so it is marked 'abandoned' and the balance is untouched. Anything larger
 * is a real pre-debited reservation and is refunded and marked 'reclaimed'.
 *
 * Deciding per-lease is what makes AI_RESERVE_SMALL_ENABLED safe to flip in
 * either direction while leases are in flight. Branching on the flag instead
 * would confiscate real legacy reservations on flip-on, and would refund-then-
 * silently-drop the charge on nominal leases on flip-off.
 */
export async function reclaimExpiredLeases(
  platformPool: pg.Pool,
  graceSeconds: number,
): Promise<ReclaimResult> {
  const client = await platformPool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{
      lease_id: string;
      user_id: string;
      organization_id: string;
      amount_usd: string;
      source_pool: 'monthly' | 'topup' | 'split';
      topup_amount_usd: string | null;
    }>(
      `SELECT lease_id, user_id, organization_id, amount_usd, source_pool, topup_amount_usd
       FROM credit_leases
       WHERE status = 'active'
         AND expires_at + ($1 || ' seconds')::interval < now()
       ORDER BY expires_at
       FOR UPDATE SKIP LOCKED
       LIMIT 500`,
      [String(graceSeconds)]
    );
    let total = 0;
    let reclaimedCount = 0;
    let abandonedCount = 0;
    for (const row of rows) {
      const amt = parseFloat(row.amount_usd);
      const sourcePool = row.source_pool;
      const topupPortion = row.topup_amount_usd ? parseFloat(row.topup_amount_usd) : 0;
      const monthlyPortion = amt - topupPortion;

      // Nominal hold: nothing meaningful to refund, and the job may still
      // settle. Abandon it so settleLease can still bill it and so the
      // aged-unsettled alert can see it.
      if (amt <= MIN_LEASE_USD) {
        await client.query(
          `UPDATE credit_leases SET status = 'abandoned', reclaimed_at = now() WHERE lease_id = $1`,
          [row.lease_id]
        );
        abandonedCount++;
        continue;
      }

      total += amt;

      if (sourcePool === 'monthly') {
        await client.query(
          `UPDATE organizations SET monthly_allowance_usd = monthly_allowance_usd + $1 WHERE id = $2`,
          [amt, row.organization_id]
        );
      } else if (sourcePool === 'topup') {
        await client.query(
          `UPDATE organizations SET credits_usd = credits_usd + $1 WHERE id = $2`,
          [amt, row.organization_id]
        );
      } else {
        // split: refund the original portions exactly.
        if (monthlyPortion > 0) {
          await client.query(
            `UPDATE organizations SET monthly_allowance_usd = monthly_allowance_usd + $1 WHERE id = $2`,
            [monthlyPortion, row.organization_id]
          );
        }
        if (topupPortion > 0) {
          await client.query(
            `UPDATE organizations SET credits_usd = credits_usd + $1 WHERE id = $2`,
            [topupPortion, row.organization_id]
          );
        }
      }

      await client.query(
        `UPDATE credit_leases SET status = 'reclaimed', reclaimed_at = now() WHERE lease_id = $1`,
        [row.lease_id]
      );
      reclaimedCount++;
    }
    await client.query('COMMIT');
    return { reclaimed: reclaimedCount, abandoned: abandonedCount, totalCreditedUsd: total };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
