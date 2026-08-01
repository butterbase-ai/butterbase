import type pg from 'pg';
import { grantLease, settleLease, type SettleResult } from '../lease-service.js';
import { config } from '../../config.js';

export interface LeaseHandle {
  leaseId: string;
  amountGrantedUsd: number;
  expiresAt: Date;
}

/** Smallest value satisfying CHECK (amount_usd > 0) on NUMERIC(12,4). */
export const MIN_LEASE_USD = 0.0001;

export class InsufficientCreditsError extends Error {
  public readonly balanceUsd: number;
  public readonly floorUsd: number;
  constructor(args: { balanceUsd: number; floorUsd: number }) {
    super(`insufficient_credits: balance ${args.balanceUsd.toFixed(4)} is below floor ${args.floorUsd.toFixed(4)}`);
    this.name = 'InsufficientCreditsError';
    this.balanceUsd = args.balanceUsd;
    this.floorUsd = args.floorUsd;
  }
}

/**
 * Shared field set for every insufficient-credits 402 body. Admission is now
 * "is your balance below your organization's credit floor" — there is no more
 * padded worst-case estimate, so `required_usd` has no honest equivalent and
 * is intentionally NOT emitted.
 *
 * `available_usd` is a DEPRECATED ALIAS for `balance_usd`, kept for one
 * deprecation release so older consumers (e.g. the dashboard agent) don't
 * silently read `undefined` while they migrate to the new field names.
 * Remove `available_usd` once all consumers read `balance_usd` directly.
 */
export function insufficientCreditsFields(error: InsufficientCreditsError): {
  balance_usd: number;
  credit_floor_usd: number;
  /** @deprecated alias for balance_usd — remove after the deprecation window */
  available_usd: number;
} {
  return {
    balance_usd: error.balanceUsd,
    credit_floor_usd: error.floorUsd,
    available_usd: error.balanceUsd,
  };
}

/**
 * Reserve a nominal amount and admit on the org's credit floor. The reservation
 * is deliberately not an estimate — the true cost is charged at settle, which
 * may debit beyond this. See the reserve-small design spec.
 */
export async function acquireNominal(
  platformPool: pg.Pool,
  userId: string,
  organizationId: string,
  region: string,
  ttlSeconds: number,
): Promise<LeaseHandle> {
  const res = await grantLease(platformPool, {
    userId,
    organizationId,
    region,
    amountUsd: MIN_LEASE_USD,
    ttlSeconds,
    allowFloor: true,
  });
  if (!res.leaseId) {
    throw new InsufficientCreditsError({ balanceUsd: res.balanceUsd, floorUsd: res.floorUsd });
  }
  return { leaseId: res.leaseId, amountGrantedUsd: res.amountGranted, expiresAt: res.expiresAt };
}

/**
 * Reserve estimatedUsd from the user's credits_usd via the lease subsystem.
 * Returns a LeaseHandle on success. Throws InsufficientCreditsError when the
 * balance can't cover the reservation.
 *
 * If grantLease returns a partial amount (less than requested), we treat that
 * as insufficient: settle the partial reservation back to 0 and throw.
 */
export async function acquireForEstimatedCost(
  platformPool: pg.Pool,
  userId: string,
  organizationId: string,
  region: string,
  estimatedUsd: number,
  ttlSeconds: number
): Promise<LeaseHandle> {
  // credit_leases.amount_usd is NUMERIC(12,4) with a CHECK (amount_usd > 0).
  // Any positive value smaller than 0.00005 rounds to 0.0000 and trips the
  // constraint, so floor at MIN_LEASE_USD — the smallest representable positive.
  // This also covers the zero-cost estimate edge case (empty embedding etc.).
  const requested = estimatedUsd < MIN_LEASE_USD ? MIN_LEASE_USD : estimatedUsd;
  const res = await grantLease(platformPool, {
    userId,
    organizationId,
    region,
    amountUsd: requested,
    ttlSeconds,
  });
  if (!res.leaseId) {
    throw new InsufficientCreditsError({ balanceUsd: res.balanceUsd, floorUsd: res.floorUsd });
  }
  if (res.amountGranted < requested) {
    // Partial reservation — refund it and surface the shortfall.
    await settleLease(platformPool, { leaseId: res.leaseId, actualUsd: 0 });
    throw new InsufficientCreditsError({ balanceUsd: res.balanceUsd, floorUsd: res.floorUsd });
  }
  return {
    leaseId: res.leaseId,
    amountGrantedUsd: res.amountGranted,
    expiresAt: res.expiresAt,
  };
}

/**
 * Settle the lease with the actual charged cost. Refunds the unspent portion.
 * Safe to call on a not-found lease — logs and returns refund=0.
 *
 * This is the single boundary where the reserve-small flag reaches the settle
 * side of the money path. With AI_RESERVE_SMALL_ENABLED unset, `allowOverdraft`
 * is false and settleLease behaves exactly as it did before this branch: the
 * charge is clamped to the reservation and nothing can debit beyond it.
 * `allowOverdraft` may be passed explicitly to override the flag (tests only).
 */
export async function settleAfterCall(
  platformPool: pg.Pool,
  handle: LeaseHandle,
  actualChargedUsd: number,
  allowOverdraft: boolean = config.aiRouter.reserveSmallEnabled,
): Promise<SettleResult> {
  try {
    return await settleLease(platformPool, {
      leaseId: handle.leaseId,
      actualUsd: actualChargedUsd,
      allowOverdraft,
    });
  } catch (err) {
    console.error(`[billing-gate] settle failed for lease ${handle.leaseId}:`, err);
    return { refundedUsd: 0, chargedUsd: 0, additionalDebitUsd: 0 };
  }
}

/**
 * Compute the dynamic TTL for a lease based on max_tokens. Longer completions
 * need longer TTLs so streaming responses don't expire mid-flight. Floor 60s,
 * ceiling 600s.
 */
export function leaseTtlSeconds(maxTokens: number): number {
  return Math.max(60, Math.min(600, 60 + Math.floor(maxTokens / 10)));
}
