import type pg from 'pg';
import type { Redis } from 'ioredis';
// Stripe charge lives in the cloud overlay; OSS mode falls back to a no-op
// that surfaces an error so callers know the feature isn't wired.
export interface AutoRefillChargeResult {
  status: 'succeeded' | 'failed';
  paymentIntentId: string;
  failureReason?: string;
}
async function purchaseAutoRefillCredits(pool: pg.Pool, organizationId: string, amount: number): Promise<AutoRefillChargeResult> {
  // @ts-expect-error — overlay path resolved at runtime
  const mod = await import('../../../../cloud-overlays/dist/cloud-overlays/billing/stripe/stripe-service.js');
  return mod.purchaseAutoRefillCredits(pool, organizationId, amount);
}
import { grantAutoRefillCredits } from './credit-grants-service.js';
import { sendBillingEmail } from './auth/email-service.js';

const LOCK_KEY_PREFIX = 'auto_refill:lock:';
const LOCK_TTL_SEC = 60;

export interface MaybeTriggerResult {
  attempted: boolean;
  status?: 'succeeded' | 'failed';
  reason?: 'not_low' | 'disabled' | 'locked' | 'charged' | 'declined' | 'org_not_found';
}

export interface Deps {
  pool: pg.Pool;
  redis: Redis;
  /** Injectable for tests; defaults wire to real Stripe + grant + DB + email. */
  stripeCharge?: (organizationId: string, amountUsd: number) => Promise<AutoRefillChargeResult>;
  grantAutoRefill?: (organizationId: string, amountUsd: number, paymentIntentId: string) => Promise<{ granted: number }>;
  flipDisabled?: (organizationId: string, reason: string) => Promise<void>;
  sendEmail?: (to: string, template: 'auto_refill_failed', data: Record<string, string>) => Promise<void>;
}

/**
 * Check whether the org qualifies for auto-refill (low balance + opted in),
 * acquire a Redis lock, and if so charge the org's Stripe Customer card.
 * Idempotent and race-safe: concurrent calls for the same org are serialized
 * by the lock; duplicate grants are blocked by the partial unique index on
 * credit_grants.stripe_event_id.
 *
 * Fire-and-forget from the AI router post-settle hook — errors logged, never
 * thrown.
 *
 * Works for both personal orgs (single owner) and team orgs (one card on the
 * org's Stripe Customer; failure emails go to every user with role='owner' in
 * organization_members).
 *
 * Audit events: NOT emitted to the `audit_events` table. The current
 * AuditEventInput shape requires `appId` (NOT NULL) and a `resourceType` from
 * a closed union that doesn't include `auto_refill`. Auto-refill is a
 * user-level operation with no app context, so it doesn't fit cleanly.
 * Durable records already cover both outcomes:
 *   - success → `credit_grants` row with reason='auto_refill'
 *   - failure → `organizations.auto_refill_last_failure_reason` +
 *     `auto_refill_last_attempt_at`, plus the failure email
 * Revisit if audit semantics change (e.g. user-scoped audit category).
 */
export async function maybeTriggerAutoRefill(deps: Deps, organizationId: string): Promise<MaybeTriggerResult> {
  // Pull the org's balance + auto-refill config + monthly allowance of any
  // owner (falls back to 0 if none — treats it as no monthly grant available).
  const r = await deps.pool.query<{
    monthly_allowance_usd: string;
    credits_usd: string;
    auto_refill_enabled: boolean;
    auto_refill_amount_usd: string | null;
  }>(
    `SELECT COALESCE(pu.monthly_allowance_usd, 0)::text AS monthly_allowance_usd,
            o.credits_usd,
            o.auto_refill_enabled,
            o.auto_refill_amount_usd
       FROM organizations o
       LEFT JOIN platform_users pu ON pu.id = o.owner_id
      WHERE o.id = $1`,
    [organizationId]
  );
  if (r.rows.length === 0) return { attempted: false, reason: 'org_not_found' };

  const u = r.rows[0];
  const monthly = parseFloat(u.monthly_allowance_usd);
  const topup = parseFloat(u.credits_usd);
  const amount = u.auto_refill_amount_usd ? parseFloat(u.auto_refill_amount_usd) : 0;

  if (monthly > 0 || topup >= 5) return { attempted: false, reason: 'not_low' };
  if (!u.auto_refill_enabled || amount <= 0) return { attempted: false, reason: 'disabled' };

  const lockKey = LOCK_KEY_PREFIX + organizationId;
  const acquired = await deps.redis.set(lockKey, '1', 'EX', LOCK_TTL_SEC, 'NX');
  if (acquired !== 'OK') return { attempted: false, reason: 'locked' };

  const charge = deps.stripeCharge ?? defaultStripeCharge(deps.pool);
  const grant = deps.grantAutoRefill ?? defaultGrant(deps.pool);
  const flip = deps.flipDisabled ?? defaultFlipDisabled(deps.pool);
  const email = deps.sendEmail ?? defaultSendEmail;

  try {
    let result: AutoRefillChargeResult;
    try {
      result = await charge(organizationId, amount);
    } catch (err) {
      console.error(`[auto-refill] charge threw for org ${organizationId}:`, err);
      const message = err instanceof Error ? err.message : 'unknown_error';
      await Promise.resolve(flip(organizationId, message)).catch((e) => console.error('[auto-refill] flip failed:', e));
      await notifyOwners(deps.pool, organizationId, email, {
        amount_usd: amount.toFixed(2),
        failure_reason: message,
      }).catch((e) => console.error('[auto-refill] email failed:', e));
      return { attempted: true, status: 'failed', reason: 'declined' };
    }

    if (result.status === 'succeeded') {
      await grant(organizationId, amount, result.paymentIntentId);
      await deps.pool.query(
        `UPDATE organizations
            SET auto_refill_last_attempt_at = now(),
                auto_refill_last_failure_reason = NULL
          WHERE id = $1`,
        [organizationId]
      );
      return { attempted: true, status: 'succeeded', reason: 'charged' };
    }

    const reason = result.failureReason ?? 'unknown';
    await flip(organizationId, reason);
    await notifyOwners(deps.pool, organizationId, email, {
      amount_usd: amount.toFixed(2),
      failure_reason: reason,
    });
    return { attempted: true, status: 'failed', reason: 'declined' };
  } finally {
    await deps.redis.del(lockKey).catch(() => {});
  }
}

/**
 * Email every owner of the org — for personal orgs that's exactly one user
 * (the account holder); for team orgs it's every member with role='owner'.
 */
async function notifyOwners(
  pool: pg.Pool,
  organizationId: string,
  email: (to: string, template: 'auto_refill_failed', data: Record<string, string>) => Promise<void>,
  data: Record<string, string>,
): Promise<void> {
  const { rows } = await pool.query<{ email: string }>(
    `SELECT DISTINCT pu.email
       FROM organization_members om
       JOIN platform_users pu ON pu.id = om.user_id
      WHERE om.organization_id = $1 AND om.role = 'owner' AND pu.email IS NOT NULL`,
    [organizationId]
  );
  await Promise.all(
    rows.map((r) =>
      Promise.resolve()
        .then(() => email(r.email, 'auto_refill_failed', data))
        .catch((err) => console.error(`[auto-refill] email to ${r.email} failed:`, err))
    )
  );
}

// ---- default wirings ----

function defaultStripeCharge(pool: pg.Pool) {
  return (organizationId: string, amount: number) => purchaseAutoRefillCredits(pool, organizationId, amount);
}

function defaultGrant(pool: pg.Pool) {
  return async (organizationId: string, amount: number, paymentIntentId: string) => {
    return grantAutoRefillCredits(pool, { organizationId, amountUsd: amount, stripeEventId: paymentIntentId });
  };
}

function defaultFlipDisabled(pool: pg.Pool) {
  return async (organizationId: string, reason: string) => {
    await pool.query(
      `UPDATE organizations
         SET auto_refill_enabled = FALSE,
             auto_refill_last_attempt_at = now(),
             auto_refill_last_failure_reason = $2
       WHERE id = $1`,
      [organizationId, reason]
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
