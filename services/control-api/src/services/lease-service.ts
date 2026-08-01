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
  /** Reserve-small mode: the reservation was nominal, so the true cost is
   *  charged here and may exceed it — the delta is debited (monthly first,
   *  then credits_usd, which may go negative). Also makes 'abandoned' a
   *  settleable status, since an expired nominal lease was never refunded.
   *
   *  When false (the default, and the state of the world with
   *  AI_RESERVE_SMALL_ENABLED unset) this function behaves exactly as it did
   *  before reserve-small: the charge is clamped to the granted amount, only
   *  'active' leases settle, and no path can debit beyond the reservation. */
  allowOverdraft?: boolean;
}

export interface SettleResult {
  refundedUsd: number;
  /** What the customer was actually billed for this lease. */
  chargedUsd: number;
  /** Amount debited beyond the original reservation (0 when refunding). */
  additionalDebitUsd: number;
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
    // Legacy (allowOverdraft off): only 'active' settles — anything else was
    // already settled or already refunded by the reclaim path.
    //
    // Reserve-small (allowOverdraft on): 'abandoned' is ALSO settleable. A job
    // whose nominal lease expired can still complete, and it must still bill —
    // otherwise expiry is a free-usage hole. 'abandoned' is never refunded, so
    // billing it cannot double-charge. 'settled' is terminal either way, and
    // legacy 'reclaimed'/'expired'/'returned' were refunded by the old reclaim
    // path, so re-charging them would double-bill; they stay terminal.
    const status = r.rows[0].status;
    const settleable = status === 'active'
      || (args.allowOverdraft === true && status === 'abandoned');
    if (!settleable) {
      await client.query('COMMIT');
      return { refundedUsd: 0, chargedUsd: 0, additionalDebitUsd: 0 };
    }

    const granted = parseFloat(r.rows[0].amount_usd);
    // Legacy clamps the charge to the reservation (never bills beyond what was
    // pre-debited). Reserve-small bills the true cost and trues up the delta.
    const actual = args.allowOverdraft
      ? Math.max(0, args.actualUsd)
      : Math.min(Math.max(0, args.actualUsd), granted);
    const delta = +(actual - granted).toFixed(4);
    const orgIdRow = r.rows[0].organization_id;
    const sourcePool = r.rows[0].source_pool;
    const topupPortion = r.rows[0].topup_amount_usd ? parseFloat(r.rows[0].topup_amount_usd) : 0;
    const monthlyPortion = granted - topupPortion;

    await client.query(
      `UPDATE credit_leases
         SET status = 'settled', settled_amount_usd = $1, settled_at = now()
       WHERE lease_id = $2`,
      [actual, args.leaseId]
    );

    let refund = 0;
    let additionalDebit = 0;

    // `delta > 0` is unreachable when allowOverdraft is false (actual is clamped
    // to granted above); the explicit conjunct is defence in depth so no future
    // edit can leak an overdraft debit onto the legacy path.
    if (delta > 0 && args.allowOverdraft === true) {
      // True-up. Drain monthly to zero first, then let credits_usd go negative.
      additionalDebit = delta;
      const cur = await client.query<{ monthly_allowance_usd: string }>(
        `SELECT monthly_allowance_usd FROM organizations WHERE id = $1 FOR UPDATE`,
        [orgIdRow]
      );
      const monthlyNow = parseFloat(cur.rows[0].monthly_allowance_usd);
      const fromMonthly = Math.max(0, Math.min(monthlyNow, delta));
      const fromTopup = +(delta - fromMonthly).toFixed(4);
      if (fromMonthly > 0) {
        await client.query(
          `UPDATE organizations SET monthly_allowance_usd = monthly_allowance_usd - $1 WHERE id = $2`,
          [fromMonthly, orgIdRow]
        );
      }
      if (fromTopup > 0) {
        await client.query(
          `UPDATE organizations SET credits_usd = credits_usd - $1 WHERE id = $2`,
          [fromTopup, orgIdRow]
        );
      }
    } else if (delta < 0) {
      refund = +(-delta).toFixed(4);
      if (sourcePool === 'monthly') {
        await client.query(
          `UPDATE organizations SET monthly_allowance_usd = monthly_allowance_usd + $1 WHERE id = $2`,
          [refund, orgIdRow]
        );
      } else if (sourcePool === 'topup') {
        await client.query(
          `UPDATE organizations SET credits_usd = credits_usd + $1 WHERE id = $2`,
          [refund, orgIdRow]
        );
      } else {
        const monthlyRefund = +((refund * monthlyPortion) / granted).toFixed(4);
        const topupRefund = +(refund - monthlyRefund).toFixed(4);
        if (monthlyRefund > 0) {
          await client.query(
            `UPDATE organizations SET monthly_allowance_usd = monthly_allowance_usd + $1 WHERE id = $2`,
            [monthlyRefund, orgIdRow]
          );
        }
        if (topupRefund > 0) {
          await client.query(
            `UPDATE organizations SET credits_usd = credits_usd + $1 WHERE id = $2`,
            [topupRefund, orgIdRow]
          );
        }
      }
    }

    await client.query('COMMIT');
    return { refundedUsd: refund, chargedUsd: actual, additionalDebitUsd: additionalDebit };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
