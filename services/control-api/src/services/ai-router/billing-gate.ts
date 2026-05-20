import type pg from 'pg';
import { grantLease, settleLease } from '../lease-service.js';

export interface LeaseHandle {
  leaseId: string;
  amountGrantedUsd: number;
  expiresAt: Date;
}

export class InsufficientCreditsError extends Error {
  constructor(
    public readonly requiredUsd: number,
    public readonly availableUsd: number
  ) {
    super(`insufficient_credits: required ${requiredUsd.toFixed(4)}, available ${availableUsd.toFixed(4)}`);
    this.name = 'InsufficientCreditsError';
  }
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
  region: string,
  estimatedUsd: number,
  ttlSeconds: number
): Promise<LeaseHandle> {
  // credit_leases.amount_usd is NUMERIC(12,4) with a CHECK (amount_usd > 0).
  // Any positive value smaller than 0.00005 rounds to 0.0000 and trips the
  // constraint, so floor at 0.0001 — the smallest representable positive.
  // This also covers the zero-cost estimate edge case (empty embedding etc.).
  const MIN_LEASE_USD = 0.0001;
  const requested = estimatedUsd < MIN_LEASE_USD ? MIN_LEASE_USD : estimatedUsd;
  const res = await grantLease(platformPool, {
    userId,
    region,
    amountUsd: requested,
    ttlSeconds,
  });
  if (!res.leaseId) {
    throw new InsufficientCreditsError(requested, res.amountGranted);
  }
  if (res.amountGranted < requested) {
    // Partial reservation — refund it and surface the shortfall.
    await settleLease(platformPool, { leaseId: res.leaseId, actualUsd: 0 });
    throw new InsufficientCreditsError(requested, res.amountGranted);
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
 */
export async function settleAfterCall(
  platformPool: pg.Pool,
  handle: LeaseHandle,
  actualChargedUsd: number
): Promise<{ refundedUsd: number }> {
  try {
    return await settleLease(platformPool, {
      leaseId: handle.leaseId,
      actualUsd: actualChargedUsd,
    });
  } catch (err) {
    console.error(`[billing-gate] settle failed for lease ${handle.leaseId}:`, err);
    return { refundedUsd: 0 };
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
