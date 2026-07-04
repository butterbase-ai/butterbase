import type pg from 'pg';

export interface ReclaimResult {
  reclaimed: number;
  totalCreditedUsd: number;
}

export async function reclaimExpiredLeases(
  platformPool: pg.Pool,
  graceSeconds: number
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
    for (const row of rows) {
      const amt = parseFloat(row.amount_usd);
      const sourcePool = row.source_pool;
      const topupPortion = row.topup_amount_usd ? parseFloat(row.topup_amount_usd) : 0;
      const monthlyPortion = amt - topupPortion;
      total += amt;

      if (sourcePool === 'monthly') {
        await client.query(
          `UPDATE platform_users SET monthly_allowance_usd = monthly_allowance_usd + $1 WHERE id = $2`,
          [amt, row.user_id]
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
            `UPDATE platform_users SET monthly_allowance_usd = monthly_allowance_usd + $1 WHERE id = $2`,
            [monthlyPortion, row.user_id]
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
    }
    await client.query('COMMIT');
    return { reclaimed: rows.length, totalCreditedUsd: total };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
