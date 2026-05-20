import type pg from 'pg';
import type { Redis } from 'ioredis';
// Stripe charge lives in the cloud overlay; OSS mode falls back to a no-op
// that surfaces an error so callers know the feature isn't wired.
export interface AutoRefillChargeResult {
  status: 'succeeded' | 'failed';
  paymentIntentId: string;
  failureReason?: string;
}
async function purchaseAutoRefillCredits(pool: pg.Pool, userId: string, amount: number): Promise<AutoRefillChargeResult> {
  // @ts-expect-error — overlay path resolved at runtime
  const mod = await import('../../../../cloud-overlays/dist/cloud-overlays/billing/stripe/stripe-service.js');
  return mod.purchaseAutoRefillCredits(pool, userId, amount);
}
import { grantAutoRefillCredits } from './credit-grants-service.js';
import { sendBillingEmail } from './auth/email-service.js';

const LOCK_KEY_PREFIX = 'auto_refill:lock:';
const LOCK_TTL_SEC = 60;

export interface MaybeTriggerResult {
  attempted: boolean;
  status?: 'succeeded' | 'failed';
  reason?: 'not_low' | 'disabled' | 'locked' | 'charged' | 'declined';
}

export interface Deps {
  pool: pg.Pool;
  redis: Redis;
  /** Injectable for tests; defaults wire to real Stripe + grant + DB + email. */
  stripeCharge?: (userId: string, amountUsd: number) => Promise<AutoRefillChargeResult>;
  grantAutoRefill?: (userId: string, amountUsd: number, paymentIntentId: string) => Promise<{ granted: number }>;
  flipDisabled?: (userId: string, reason: string) => Promise<void>;
  sendEmail?: (to: string, template: 'auto_refill_failed', data: Record<string, string>) => Promise<void>;
}

/**
 * Check whether the user qualifies for auto-refill (low balance + opted in),
 * acquire a Redis lock, and if so charge their card. Idempotent and race-safe:
 * concurrent calls for the same user are serialized by the lock; duplicate
 * grants are blocked by the partial unique index on credit_grants.stripe_event_id.
 *
 * Fire-and-forget from the AI router post-settle hook — errors logged, never
 * thrown.
 *
 * Audit events: NOT emitted to the `audit_events` table. The current
 * AuditEventInput shape requires `appId` (NOT NULL) and a `resourceType` from
 * a closed union that doesn't include `auto_refill`. Auto-refill is a
 * user-level operation with no app context, so it doesn't fit cleanly.
 * Durable records already cover both outcomes:
 *   - success → `credit_grants` row with reason='auto_refill'
 *   - failure → `platform_users.auto_refill_last_failure_reason` +
 *     `auto_refill_last_attempt_at`, plus the failure email
 * Revisit if audit semantics change (e.g. user-scoped audit category).
 */
export async function maybeTriggerAutoRefill(deps: Deps, userId: string): Promise<MaybeTriggerResult> {
  const r = await deps.pool.query<{
    monthly_allowance_usd: string;
    credits_usd: string;
    auto_refill_enabled: boolean;
    auto_refill_amount_usd: string | null;
    email: string;
  }>(
    `SELECT monthly_allowance_usd, credits_usd, auto_refill_enabled, auto_refill_amount_usd, email
     FROM platform_users WHERE id = $1`,
    [userId]
  );
  if (r.rows.length === 0) return { attempted: false, reason: 'not_low' };

  const u = r.rows[0];
  const monthly = parseFloat(u.monthly_allowance_usd);
  const topup = parseFloat(u.credits_usd);
  const amount = u.auto_refill_amount_usd ? parseFloat(u.auto_refill_amount_usd) : 0;

  if (monthly > 0 || topup >= 5) return { attempted: false, reason: 'not_low' };
  if (!u.auto_refill_enabled || amount <= 0) return { attempted: false, reason: 'disabled' };

  const lockKey = LOCK_KEY_PREFIX + userId;
  const acquired = await deps.redis.set(lockKey, '1', 'EX', LOCK_TTL_SEC, 'NX');
  if (acquired !== 'OK') return { attempted: false, reason: 'locked' };

  const charge = deps.stripeCharge ?? defaultStripeCharge(deps.pool);
  const grant = deps.grantAutoRefill ?? defaultGrant(deps.pool);
  const flip = deps.flipDisabled ?? defaultFlipDisabled(deps.pool);
  const email = deps.sendEmail ?? defaultSendEmail;

  try {
    let result: AutoRefillChargeResult;
    try {
      result = await charge(userId, amount);
    } catch (err) {
      console.error(`[auto-refill] charge threw for user ${userId}:`, err);
      const message = err instanceof Error ? err.message : 'unknown_error';
      await Promise.resolve(flip(userId, message)).catch((e) => console.error('[auto-refill] flip failed:', e));
      await Promise.resolve(email(u.email, 'auto_refill_failed', {
        amount_usd: amount.toFixed(2),
        failure_reason: message,
      })).catch((e) => console.error('[auto-refill] email failed:', e));
      return { attempted: true, status: 'failed', reason: 'declined' };
    }

    if (result.status === 'succeeded') {
      await grant(userId, amount, result.paymentIntentId);
      await deps.pool.query(
        `UPDATE platform_users
            SET auto_refill_last_attempt_at = now(),
                auto_refill_last_failure_reason = NULL
          WHERE id = $1`,
        [userId]
      );
      return { attempted: true, status: 'succeeded', reason: 'charged' };
    }

    const reason = result.failureReason ?? 'unknown';
    await flip(userId, reason);
    await email(u.email, 'auto_refill_failed', {
      amount_usd: amount.toFixed(2),
      failure_reason: reason,
    });
    return { attempted: true, status: 'failed', reason: 'declined' };
  } finally {
    await deps.redis.del(lockKey).catch(() => {});
  }
}

// ---- default wirings ----

function defaultStripeCharge(pool: pg.Pool) {
  return (userId: string, amount: number) => purchaseAutoRefillCredits(pool, userId, amount);
}

function defaultGrant(pool: pg.Pool) {
  return async (userId: string, amount: number, paymentIntentId: string) => {
    return grantAutoRefillCredits(pool, { userId, amountUsd: amount, stripeEventId: paymentIntentId });
  };
}

function defaultFlipDisabled(pool: pg.Pool) {
  return async (userId: string, reason: string) => {
    await pool.query(
      `UPDATE platform_users
         SET auto_refill_enabled = FALSE,
             auto_refill_last_attempt_at = now(),
             auto_refill_last_failure_reason = $2
       WHERE id = $1`,
      [userId, reason]
    );
  };
}

const defaultSendEmail = async (
  to: string,
  template: 'auto_refill_failed',
  data: Record<string, string>
) => {
  await sendBillingEmail(to, template, data);
};
