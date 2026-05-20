import type pg from 'pg';

export interface GrantArgs {
  userId: string;
  region: string;
  amountUsd: number;
  ttlSeconds: number;
}

export interface GrantResult {
  leaseId: string | null;        // null = zero-amount grant (balance exhausted)
  amountGranted: number;         // may be less than requested if balance is low
  expiresAt: Date;
}

export async function grantLease(platformPool: pg.Pool, args: GrantArgs): Promise<GrantResult> {
  if (args.amountUsd <= 0) throw new Error('grantLease: amountUsd must be positive');
  if (args.ttlSeconds <= 0) throw new Error('grantLease: ttlSeconds must be positive');

  const client = await platformPool.connect();
  try {
    await client.query('BEGIN');
    const u = await client.query<{ monthly_allowance_usd: string; credits_usd: string }>(
      `SELECT monthly_allowance_usd, credits_usd
       FROM platform_users WHERE id = $1 FOR UPDATE`,
      [args.userId]
    );
    if (u.rows.length === 0) throw new Error(`grantLease: user ${args.userId} not found`);

    const monthly = parseFloat(u.rows[0].monthly_allowance_usd);
    const topup = parseFloat(u.rows[0].credits_usd);
    const totalAvailable = monthly + topup;
    const granted = Math.min(totalAvailable, args.amountUsd);
    const expires = new Date(Date.now() + args.ttlSeconds * 1000);

    if (granted <= 0) {
      await client.query('COMMIT');
      return { leaseId: null, amountGranted: 0, expiresAt: expires };
    }

    const monthlyDraw = Math.min(monthly, granted);
    const topupDraw = granted - monthlyDraw;
    let sourcePool: 'monthly' | 'topup' | 'split';
    let topupAmountColumn: number | null;
    if (monthlyDraw > 0 && topupDraw === 0) {
      sourcePool = 'monthly';
      topupAmountColumn = null;
    } else if (monthlyDraw === 0 && topupDraw > 0) {
      sourcePool = 'topup';
      topupAmountColumn = null;
    } else {
      sourcePool = 'split';
      topupAmountColumn = topupDraw;
    }

    if (monthlyDraw > 0) {
      await client.query(
        `UPDATE platform_users SET monthly_allowance_usd = monthly_allowance_usd - $1 WHERE id = $2`,
        [monthlyDraw, args.userId]
      );
    }
    if (topupDraw > 0) {
      await client.query(
        `UPDATE platform_users SET credits_usd = credits_usd - $1 WHERE id = $2`,
        [topupDraw, args.userId]
      );
    }

    const ins = await client.query<{ lease_id: string }>(
      `INSERT INTO credit_leases (user_id, region, amount_usd, expires_at, status, source_pool, topup_amount_usd)
       VALUES ($1, $2, $3, $4, 'active', $5, $6)
       RETURNING lease_id`,
      [args.userId, args.region, granted, expires, sourcePool, topupAmountColumn]
    );

    await client.query('COMMIT');
    return { leaseId: ins.rows[0].lease_id, amountGranted: granted, expiresAt: expires };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export interface SettleArgs {
  leaseId: string;
  actualUsd: number;
}

export interface SettleResult {
  refundedUsd: number;
}

export async function settleLease(
  platformPool: pg.Pool,
  args: SettleArgs
): Promise<SettleResult> {
  const client = await platformPool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query<{
      user_id: string;
      amount_usd: string;
      status: string;
      source_pool: 'monthly' | 'topup' | 'split';
      topup_amount_usd: string | null;
    }>(
      `SELECT user_id, amount_usd, status, source_pool, topup_amount_usd
       FROM credit_leases WHERE lease_id = $1 FOR UPDATE`,
      [args.leaseId]
    );
    if (r.rows.length === 0) {
      await client.query('ROLLBACK');
      throw new Error(`settleLease: lease not found: ${args.leaseId}`);
    }
    if (r.rows[0].status !== 'active') {
      await client.query('COMMIT');
      return { refundedUsd: 0 }; // idempotent: already settled or reclaimed
    }

    const granted = parseFloat(r.rows[0].amount_usd);
    const actual = Math.min(Math.max(0, args.actualUsd), granted);
    const refund = +(granted - actual).toFixed(4);
    const sourcePool = r.rows[0].source_pool;
    const topupPortion = r.rows[0].topup_amount_usd ? parseFloat(r.rows[0].topup_amount_usd) : 0;
    const monthlyPortion = granted - topupPortion;

    await client.query(
      `UPDATE credit_leases
         SET status = 'settled', settled_amount_usd = $1, settled_at = now()
       WHERE lease_id = $2`,
      [actual, args.leaseId]
    );

    if (refund > 0) {
      if (sourcePool === 'monthly') {
        await client.query(
          `UPDATE platform_users SET monthly_allowance_usd = monthly_allowance_usd + $1 WHERE id = $2`,
          [refund, r.rows[0].user_id]
        );
      } else if (sourcePool === 'topup') {
        await client.query(
          `UPDATE platform_users SET credits_usd = credits_usd + $1 WHERE id = $2`,
          [refund, r.rows[0].user_id]
        );
      } else {
        // split: pro-rate the refund by the original pool proportions.
        const monthlyRefund = +((refund * monthlyPortion) / granted).toFixed(4);
        const topupRefund = +(refund - monthlyRefund).toFixed(4); // preserve total via remainder
        if (monthlyRefund > 0) {
          await client.query(
            `UPDATE platform_users SET monthly_allowance_usd = monthly_allowance_usd + $1 WHERE id = $2`,
            [monthlyRefund, r.rows[0].user_id]
          );
        }
        if (topupRefund > 0) {
          await client.query(
            `UPDATE platform_users SET credits_usd = credits_usd + $1 WHERE id = $2`,
            [topupRefund, r.rows[0].user_id]
          );
        }
      }
    }

    await client.query('COMMIT');
    return { refundedUsd: refund };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
