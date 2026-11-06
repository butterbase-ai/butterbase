import type pg from 'pg';
import { NotFoundError } from './api-errors.js';
import { roundCreditUsd as roundUsd } from './credit-precision.js';

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
  /** Optional durable caller identity. Replays never debit twice. */
  reservationId?: string;
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

/** A closed identity can never acquire a new lease, even if no lease existed. */
export class ReservationClosedError extends Error {
  constructor() {
    super('Reservation is closed');
    this.name = 'ReservationClosedError';
  }
}

export interface LeaseReservationClosure {
  reservationId: string;
  organizationId: string;
  hadLease: boolean;
  closedAt: Date;
}

async function lockReservation(client: pg.PoolClient, reservationId: string): Promise<void> {
  // Must precede the organization lock in grantLease. Closure itself never
  // acquires an org/lease row lock; existing settlement runs after this commit.
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('credit-reservation:' || $1::uuid::text, 0))", [reservationId]);
}

export async function getLeaseReservationClosure(
  db: pg.Pool | pg.PoolClient,
  args: { reservationId: string; organizationId: string },
): Promise<LeaseReservationClosure | null> {
  const result = await db.query<{ reservation_id: string; organization_id: string; had_lease: boolean; closed_at: Date }>(
    'SELECT reservation_id,organization_id,had_lease,closed_at FROM credit_reservation_closures WHERE reservation_id=$1',
    [args.reservationId],
  );
  const row = result.rows[0];
  if (!row) return null;
  if (row.organization_id !== args.organizationId) throw new Error('Reservation identity mismatch');
  return { reservationId: row.reservation_id, organizationId: row.organization_id, hadLease: row.had_lease, closedAt: row.closed_at };
}

/**
 * Serialize closure against ALL grants of this identity, including an absent
 * lease. hadLease=false is durable evidence that no grant can ever arrive.
 * hadLease=true still requires ordinary terminal settlement before a receipt.
 */
export async function closeLeaseReservation(
  platformPool: pg.Pool,
  args: { reservationId: string; organizationId: string },
): Promise<LeaseReservationClosure> {
  const client = await platformPool.connect();
  try {
    await client.query('BEGIN');
    await lockReservation(client, args.reservationId);
    const existing = await getLeaseReservationClosure(client, args);
    if (existing) {
      await client.query('COMMIT');
      return existing;
    }
    const lease = await client.query<{ organization_id: string }>(
      'SELECT organization_id FROM credit_leases WHERE lease_id=$1', [args.reservationId],
    );
    if (lease.rows[0] && lease.rows[0].organization_id !== args.organizationId) throw new Error('Reservation identity mismatch');
    await client.query(
      'INSERT INTO credit_reservation_closures(reservation_id,organization_id,had_lease) VALUES ($1,$2,$3)',
      [args.reservationId,args.organizationId,lease.rows.length > 0],
    );
    const closed = (await getLeaseReservationClosure(client, args))!;
    await client.query('COMMIT');
    return closed;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * The exact columns and floor resolution `grantLease` admits on:
 * `COALESCE(organizations.credit_floor_usd, plans.credit_floor_usd, 0)`.
 * A per-org override beats the plan's tier default, which beats 0 when there
 * is no plan at all (plan_id NULL or dangling).
 *
 * Kept as one string so the read-only inspector and the leasing path cannot
 * drift apart. `grantLease` appends `FOR UPDATE OF o` to serialize its own
 * write; `readOrganizationCreditState` reads without a lock.
 */
const CREDIT_STATE_SELECT = `SELECT o.monthly_allowance_usd,
       o.credits_usd,
       COALESCE(o.credit_floor_usd, p.credit_floor_usd, 0) AS credit_floor_usd
  FROM organizations o
  LEFT JOIN plans p ON p.id = o.plan_id`;

interface CreditStateRow {
  monthly_allowance_usd: string;
  credits_usd: string;
  credit_floor_usd: string;
}

export interface OrganizationCreditState {
  /** Combined balance: monthly allowance + top-up credits. */
  balanceUsd: number;
  /** Effective admission floor for this organization. */
  floorUsd: number;
}

function parseCreditState(row: CreditStateRow): OrganizationCreditState {
  return {
    balanceUsd: parseFloat(row.monthly_allowance_usd) + parseFloat(row.credits_usd),
    floorUsd: parseFloat(row.credit_floor_usd),
  };
}

/**
 * Read-only mirror of `grantLease`'s admission inputs. Returns null when the
 * organization does not exist. Never locks, leases, or debits anything; the
 * gateway's own `grantLease` remains the authoritative admission decision.
 */
export async function readOrganizationCreditState(
  db: pg.Pool | pg.PoolClient,
  organizationId: string,
): Promise<OrganizationCreditState | null> {
  const result = await db.query<CreditStateRow>(
    `${CREDIT_STATE_SELECT}
     WHERE o.id = $1`,
    [organizationId],
  );
  const row = result.rows[0];
  return row ? parseCreditState(row) : null;
}

export async function grantLease(platformPool: pg.Pool, args: GrantArgs): Promise<GrantResult> {
  const requested = roundUsd(args.amountUsd);
  if (requested <= 0) throw new Error('grantLease: amountUsd must be positive');
  if (args.ttlSeconds <= 0) throw new Error('grantLease: ttlSeconds must be positive');

  const client = await platformPool.connect();
  try {
    await client.query('BEGIN');
    if (args.reservationId) {
      await lockReservation(client, args.reservationId);
      if (await getLeaseReservationClosure(client, { reservationId: args.reservationId, organizationId: args.organizationId })) {
        throw new ReservationClosedError();
      }
    }
    // Per-org billing (Phase 3b). Caller passes args.organizationId — this
    // is the app's owning org (AI gateway) or an explicit billing subject.
    // No implicit personal-org fallback at this layer.
    const organizationId = args.organizationId;
    // Floor resolution and admission arithmetic live in CREDIT_STATE_SELECT /
    // parseCreditState so the read-only funding inspector cannot drift from
    // this path.
    //
    // `FOR UPDATE OF o` on purpose: this SELECT joins plans, and a bare
    // `FOR UPDATE` on a join takes row locks on BOTH tables. Locking a shared
    // plan row on every AI request would serialise unrelated traffic across
    // every org on that tier and risks deadlock. Scoping the lock to `o`
    // leaves plans unlocked; organizations is the only row this function
    // mutates.
    const u = await client.query<CreditStateRow>(
      `${CREDIT_STATE_SELECT}
       WHERE o.id = $1 FOR UPDATE OF o`,
      [organizationId]
    );
    if (u.rows.length === 0) throw new NotFoundError('organization', organizationId);

    // `monthly` is also needed to draw the allowance before top-up credits.
    const monthly = parseFloat(u.rows[0].monthly_allowance_usd);
    const { balanceUsd: totalAvailable, floorUsd: floor } = parseCreditState(u.rows[0]);
    const expires = new Date(Date.now() + args.ttlSeconds * 1000);

    if (args.reservationId) {
      const existing = await client.query<{ lease_id: string; organization_id: string; user_id: string; region: string; amount_usd: string; expires_at: Date; status: string }>(
        'SELECT lease_id,organization_id,user_id,region,amount_usd,expires_at,status FROM credit_leases WHERE lease_id=$1', [args.reservationId]);
      const row = existing.rows[0];
      if (row) {
        if (row.organization_id !== organizationId || row.user_id !== args.userId || row.region !== args.region || Number(row.amount_usd) !== requested) throw new Error('Reservation identity mismatch');
        if (row.status !== 'active' || row.expires_at <= new Date()) throw new Error('Reservation is no longer active');
        // Reauthorization on replay excludes this reservation's own draw.
        if (args.allowFloor && totalAvailable + Number(row.amount_usd) < floor) {
          await client.query('COMMIT');
          return { leaseId: null, amountGranted: 0, expiresAt: row.expires_at, balanceUsd: totalAvailable, floorUsd: floor };
        }
        await client.query('COMMIT');
        return { leaseId: row.lease_id, amountGranted: Number(row.amount_usd), expiresAt: row.expires_at, balanceUsd: totalAvailable, floorUsd: floor };
      }
    }

    let granted: number;
    if (args.allowFloor) {
      // Admission is the floor check; the amount is then granted in full.
      if (totalAvailable < floor) {
        await client.query('COMMIT');
        return { leaseId: null, amountGranted: 0, expiresAt: expires, balanceUsd: totalAvailable, floorUsd: floor };
      }
      granted = requested;
    } else {
      granted = roundUsd(Math.min(totalAvailable, requested));
    }

    if (granted <= 0) {
      await client.query('COMMIT');
      return { leaseId: null, amountGranted: 0, expiresAt: expires, balanceUsd: totalAvailable, floorUsd: floor };
    }

    // monthly is drawn first and never driven negative; credits_usd absorbs the
    // remainder and is the ONLY column permitted to go negative (it persists
    // across billing cycles, so debt cannot be erased by a monthly reset).
    const monthlyDraw = roundUsd(Math.max(0, Math.min(monthly, granted)));
    const topupDraw = roundUsd(granted - monthlyDraw);
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
      `INSERT INTO credit_leases (user_id, organization_id, region, amount_usd, expires_at, status, source_pool, topup_amount_usd, lease_id)
       VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, COALESCE($8::uuid,gen_random_uuid()))
       RETURNING lease_id`,
      [args.userId, organizationId, args.region, granted, expires, sourcePool, topupAmountColumn, args.reservationId ?? null]
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
    const actual = roundUsd(args.allowOverdraft
      ? Math.max(0, args.actualUsd)
      : Math.min(Math.max(0, args.actualUsd), granted));
    const delta = roundUsd(actual - granted);
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
      const fromMonthly = roundUsd(Math.max(0, Math.min(monthlyNow, delta)));
      const fromTopup = roundUsd(delta - fromMonthly);
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
      refund = -delta;
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
        const monthlyRefund = roundUsd((refund * monthlyPortion) / granted);
        const topupRefund = roundUsd(refund - monthlyRefund);
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
