import type pg from 'pg';
import { NotFoundError } from './api-errors.js';

export interface GrantArgs {
  /** User whose action is being billed (audit + credit_leases.user_id). */
  userId: string;
  /** Organization whose credit pools are drawn — under per-org billing this
   *  is the app's owning org (from resolveOrgFromApp) or the caller's
   *  explicit billing org, never a personal-org default at this layer. */
  organizationId: string;
  region: string;
  amountUsd: number;
  ttlSeconds: number;
  /** Reserve-small mode: admit on `balance >= credit_floor_usd` and grant the
   *  FULL amount rather than partial-granting down to the balance. Overdraft
   *  lands in credits_usd, which may go negative. */
  allowFloor?: boolean;
}

export interface GrantResult {
  leaseId: string | null;        // null = zero-amount grant (balance exhausted)
  amountGranted: number;         // may be less than requested if balance is low
  expiresAt: Date;
  /** Combined balance observed under the row lock. */
  balanceUsd: number;
  /** The org's configured floor. */
  floorUsd: number;
}

export async function grantLease(platformPool: pg.Pool, args: GrantArgs): Promise<GrantResult> {
  if (args.amountUsd <= 0) throw new Error('grantLease: amountUsd must be positive');
  if (args.ttlSeconds <= 0) throw new Error('grantLease: ttlSeconds must be positive');

  const client = await platformPool.connect();
  try {
    await client.query('BEGIN');
    // Per-org billing (Phase 3b). Caller passes args.organizationId — this
    // is the app's owning org (AI gateway) or an explicit billing subject.
    // No implicit personal-org fallback at this layer.
    const organizationId = args.organizationId;
    const u = await client.query<{
      monthly_allowance_usd: string;
      credits_usd: string;
      credit_floor_usd: string;
    }>(
      `SELECT monthly_allowance_usd, credits_usd, credit_floor_usd
       FROM organizations
       WHERE id = $1 FOR UPDATE`,
      [organizationId]
    );
    if (u.rows.length === 0) throw new NotFoundError('organization', organizationId);

    const monthly = parseFloat(u.rows[0].monthly_allowance_usd);
    const topup = parseFloat(u.rows[0].credits_usd);
    const floor = parseFloat(u.rows[0].credit_floor_usd);
    const totalAvailable = monthly + topup;
    const expires = new Date(Date.now() + args.ttlSeconds * 1000);

    let granted: number;
    if (args.allowFloor) {
      // Admission is the floor check; the amount is then granted in full.
      if (totalAvailable < floor) {
        await client.query('COMMIT');
        return { leaseId: null, amountGranted: 0, expiresAt: expires, balanceUsd: totalAvailable, floorUsd: floor };
      }
      granted = args.amountUsd;
    } else {
      granted = Math.min(totalAvailable, args.amountUsd);
    }

    if (granted <= 0) {
      await client.query('COMMIT');
      return { leaseId: null, amountGranted: 0, expiresAt: expires, balanceUsd: totalAvailable, floorUsd: floor };
    }

    // monthly is drawn first and never driven negative; credits_usd absorbs the
    // remainder and is the ONLY column permitted to go negative (it persists
    // across billing cycles, so debt cannot be erased by a monthly reset).
    const monthlyDraw = Math.max(0, Math.min(monthly, granted));
    const topupDraw = +(granted - monthlyDraw).toFixed(4);
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
        `UPDATE organizations SET monthly_allowance_usd = monthly_allowance_usd - $1 WHERE id = $2`,
        [monthlyDraw, organizationId]
      );
    }
    if (topupDraw > 0) {
      await client.query(
        `UPDATE organizations SET credits_usd = credits_usd - $1 WHERE id = $2`,
        [topupDraw, organizationId]
      );
    }

    const ins = await client.query<{ lease_id: string }>(
      `INSERT INTO credit_leases (user_id, organization_id, region, amount_usd, expires_at, status, source_pool, topup_amount_usd)
       VALUES ($1, $2, $3, $4, $5, 'active', $6, $7)
       RETURNING lease_id`,
      [args.userId, organizationId, args.region, granted, expires, sourcePool, topupAmountColumn]
    );

    await client.query('COMMIT');
    return {
      leaseId: ins.rows[0].lease_id,
      amountGranted: granted,
      expiresAt: expires,
      balanceUsd: totalAvailable,
      floorUsd: floor,
    };
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
      organization_id: string;
      amount_usd: string;
      status: string;
      source_pool: 'monthly' | 'topup' | 'split';
      topup_amount_usd: string | null;
    }>(
      `SELECT user_id, organization_id, amount_usd, status, source_pool, topup_amount_usd
       FROM credit_leases WHERE lease_id = $1 FOR UPDATE`,
      [args.leaseId]
    );
    if (r.rows.length === 0) {
      await client.query('ROLLBACK');
      throw new NotFoundError('lease', args.leaseId);
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
          `UPDATE organizations SET monthly_allowance_usd = monthly_allowance_usd + $1 WHERE id = $2`,
          [refund, r.rows[0].organization_id]
        );
      } else if (sourcePool === 'topup') {
        await client.query(
          `UPDATE organizations SET credits_usd = credits_usd + $1 WHERE id = $2`,
          [refund, r.rows[0].organization_id]
        );
      } else {
        // split: pro-rate the refund by the original pool proportions.
        const monthlyRefund = +((refund * monthlyPortion) / granted).toFixed(4);
        const topupRefund = +(refund - monthlyRefund).toFixed(4); // preserve total via remainder
        if (monthlyRefund > 0) {
          await client.query(
            `UPDATE organizations SET monthly_allowance_usd = monthly_allowance_usd + $1 WHERE id = $2`,
            [monthlyRefund, r.rows[0].organization_id]
          );
        }
        if (topupRefund > 0) {
          await client.query(
            `UPDATE organizations SET credits_usd = credits_usd + $1 WHERE id = $2`,
            [topupRefund, r.rows[0].organization_id]
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
