import type pg from 'pg';
import { grantLease, settleLease } from '../lease-service.js';
import { InsufficientCreditsError, type LeaseHandle } from '../ai-router/billing-gate.js';

export const FLOOR_LEASE_SECONDS = 300;
export const ACTOR_LEASE_TTL_SECONDS = 600;

export interface ReserveActorCreditsInput {
  userId: string;
  organizationId: string;
  region: string;
  recordingUsdPerSecond: number;
  transcriptionUsdPerSecond: number;
  transcript: boolean;
  markupPct: number;
}

export async function reserveActorCredits(
  platformPool: pg.Pool,
  input: ReserveActorCreditsInput,
): Promise<LeaseHandle> {
  const perSec =
    input.recordingUsdPerSecond +
    (input.transcript ? input.transcriptionUsdPerSecond : 0);
  const base = perSec * FLOOR_LEASE_SECONDS;
  const charged = base * (1 + input.markupPct / 100);
  const requested = Math.max(charged, 0.0001);

  const res = await grantLease(platformPool, {
    userId: input.userId,
    organizationId: input.organizationId,
    region: input.region,
    amountUsd: requested,
    ttlSeconds: ACTOR_LEASE_TTL_SECONDS,
  });

  if (!res.leaseId) {
    throw new InsufficientCreditsError(requested, res.amountGranted);
  }
  if (res.amountGranted < requested) {
    await settleLease(platformPool, { leaseId: res.leaseId, actualUsd: 0 });
    throw new InsufficientCreditsError(requested, res.amountGranted);
  }
  return {
    leaseId: res.leaseId,
    amountGrantedUsd: res.amountGranted,
    expiresAt: res.expiresAt,
  };
}

export interface SettleActorCallInput {
  leaseId: string;
  actualSeconds: number;
  dimensionUsdPerSecond: number;
  markupPct: number;
}

/**
 * Settle one dimension of an actor lease. Called once per (lease, dimension)
 * from the webhook handler — recording on `bot.done`, transcription on
 * `transcript.done`. `dimensionUsdPerSecond` is the cost rate for THAT
 * dimension only (e.g. 0.50/3600 for recording), NOT the combined rate
 * that was used at reservation time.
 *
 * Idempotency is enforced upstream by the actor_usage_logs unique
 * constraint on (actor_id, dimension); callers should only invoke this
 * after a successful writeActorUsageRow returns true.
 */
export async function settleActorCall(
  platformPool: pg.Pool,
  input: SettleActorCallInput,
): Promise<{ refundedUsd: number }> {
  const actualUsd = input.actualSeconds * input.dimensionUsdPerSecond * (1 + input.markupPct / 100);
  try {
    return await settleLease(platformPool, { leaseId: input.leaseId, actualUsd });
  } catch (err) {
    console.error(`[actor-billing] settle failed for lease ${input.leaseId}:`, err);
    return { refundedUsd: 0 };
  }
}
