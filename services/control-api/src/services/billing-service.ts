// services/control-api/src/services/billing-service.ts
import { Pool, PoolClient } from 'pg';
import { getCurrentUsage, getAiCreditsUsed, getStorageUsed, getDbSize, getMAU } from './usage-metering.js';
import { sendBillingEmail } from './auth/email-service.js';
import { invalidateUserAppLimits } from './app-plan-resolver.js';
import { config } from '../config.js';
import { getRuntimeDbPool } from './runtime-db.js';
import { writeUserStateChange } from './state-outbox.js';
import { resolveOrganizationId } from './org-resolver.js';

type DbClient = Pool | PoolClient;

export class BillingServiceError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(message);
    this.name = 'BillingServiceError';
  }
}

interface PlanLimits {
  maxStorageGb: number;
  maxAiCreditsUsd: number;
  maxLambdaInvocations: number;
  maxDbSizeGb: number;
  maxBandwidthGb: number;
  maxMau: number;
}

/**
 * Check if user exceeds free plan limits and apply soft-lock if needed
 * Called when subscription is canceled or downgraded to free
 */
export async function checkAndApplySoftLock(db: DbClient, userId: string): Promise<void> {
  try {
    // Get playground plan limits
    const planResult = await db.query(
      `SELECT max_storage_gb, max_ai_credits_usd, ai_credits_lifetime,
              max_lambda_invocations, max_db_size_gb, max_bandwidth_gb, max_mau
       FROM plans WHERE id = 'playground'`
    );

    if (planResult.rows.length === 0) {
      throw new BillingServiceError('Free plan not found', 'PLAN_NOT_FOUND');
    }

    const limits: PlanLimits = {
      maxStorageGb: parseFloat(planResult.rows[0].max_storage_gb),
      maxAiCreditsUsd: parseFloat(planResult.rows[0].max_ai_credits_usd),
      maxLambdaInvocations: planResult.rows[0].max_lambda_invocations,
      maxDbSizeGb: parseFloat(planResult.rows[0].max_db_size_gb),
      maxBandwidthGb: parseFloat(planResult.rows[0].max_bandwidth_gb),
      maxMau: planResult.rows[0].max_mau,
    };

    // Check each limit
    const violations: string[] = [];

    // Check storage (source-of-truth query)
    const storageBytes = await getStorageUsed(db, userId);
    const storageLimitBytes = limits.maxStorageGb * 1024 * 1024 * 1024;
    if (limits.maxStorageGb !== -1 && storageBytes > storageLimitBytes) {
      violations.push(`storage: ${(storageBytes / 1024 / 1024 / 1024).toFixed(2)}GB/${limits.maxStorageGb}GB`);
    }

    // Check database size (source-of-truth query)
    if (limits.maxDbSizeGb !== -1) {
      const dbSizeBytes = await getDbSize(db, userId);
      const dbSizeLimitBytes = limits.maxDbSizeGb * 1024 * 1024 * 1024;
      if (dbSizeBytes > dbSizeLimitBytes) {
        violations.push(`db_size: ${(dbSizeBytes / 1024 / 1024 / 1024).toFixed(2)}GB/${limits.maxDbSizeGb}GB`);
      }
    }

    // AI credit depletion is now handled by quota enforcement as a 402 response,
    // NOT a soft-lock. Only resource limits (storage, bandwidth, lambda, db_size, mau) cause soft-lock.

    // Check lambda invocations
    if (limits.maxLambdaInvocations !== -1) {
      const lambdaInvocations = await getCurrentUsage(db, userId, 'lambda_invocations');
      if (lambdaInvocations > limits.maxLambdaInvocations) {
        violations.push(`lambda_invocations: ${lambdaInvocations}/${limits.maxLambdaInvocations}`);
      }
    }

    // Check bandwidth
    if (limits.maxBandwidthGb !== -1) {
      const bandwidthBytes = await getCurrentUsage(db, userId, 'bandwidth_bytes');
      const bandwidthLimitBytes = limits.maxBandwidthGb * 1024 * 1024 * 1024;
      if (bandwidthBytes > bandwidthLimitBytes) {
        violations.push(`bandwidth: ${(bandwidthBytes / 1024 / 1024 / 1024).toFixed(2)}GB/${limits.maxBandwidthGb}GB`);
      }
    }

    // Check MAU (source-of-truth query)
    if (limits.maxMau !== -1) {
      const mauCount = await getMAU(db, userId);
      if (mauCount > limits.maxMau) {
        violations.push(`mau: ${mauCount}/${limits.maxMau}`);
      }
    }

    // Apply soft-lock if any violations
    if (violations.length > 0) {
      await writeUserStateChange(db as Pool, userId, { account_status: 'soft_locked' });

      console.log(`User ${userId} soft-locked due to: ${violations.join(', ')}`);

      // Send soft-lock notification
      const emailResult = await db.query(
        'SELECT email FROM platform_users WHERE id = $1',
        [userId]
      );
      if (emailResult.rows.length > 0) {
        await sendBillingEmail(emailResult.rows[0].email, 'soft_locked', {
          violations: violations.join(', '),
        }).catch((err) => console.error('Failed to send soft-lock email:', err));
      }
    } else {
      // No violations - ensure account is active
      await writeUserStateChange(db as Pool, userId, { account_status: 'active' });

      console.log(`User ${userId} within free plan limits, account active`);
    }
  } catch (error) {
    throw new BillingServiceError(
      `Failed to check soft-lock: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'SOFT_LOCK_CHECK_FAILED'
    );
  }
}

/**
 * Nightly cron job to check soft-locked users and auto-restore if usage drops
 */
export async function autoRestoreSoftLockedUsers(db: Pool): Promise<void> {
  try {
    // Get all soft-locked users
    const result = await db.query(
      `SELECT id FROM platform_users WHERE account_status = 'soft_locked' AND plan_id = 'playground'`
    );

    console.log(`Checking ${result.rows.length} soft-locked users for auto-restore`);

    for (const row of result.rows) {
      const userId = row.id;

      // Re-check limits (will auto-restore if within limits)
      await checkAndApplySoftLock(db, userId);
    }

    console.log('Auto-restore check completed');
  } catch (error) {
    console.error('Failed to auto-restore soft-locked users:', error);
    // Don't throw - let the next cron run handle it
  }
}

/**
 * Suspend account (hard block - used for payment failures after grace period)
 */
export async function suspendAccount(db: DbClient, userId: string, reason: string): Promise<void> {
  try {
    await writeUserStateChange(db as Pool, userId, { account_status: 'suspended' });

    // Log billing event
    const organizationIdSuspend = await resolveOrganizationId(db as Pool, userId);
    await db.query(
      `INSERT INTO billing_events (user_id, organization_id, event_type, metadata)
       VALUES ($1, $2, 'account_suspended', $3)`,
      [userId, organizationIdSuspend, JSON.stringify({ reason })]
    );

    console.log(`User ${userId} suspended: ${reason}`);

    // Send suspension notification
    const emailResult = await db.query(
      'SELECT email FROM platform_users WHERE id = $1',
      [userId]
    );
    if (emailResult.rows.length > 0) {
      await sendBillingEmail(emailResult.rows[0].email, 'account_suspended', {
        reason,
      }).catch((err) => console.error('Failed to send suspension email:', err));
    }
  } catch (error) {
    throw new BillingServiceError(
      `Failed to suspend account: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'SUSPEND_FAILED'
    );
  }
}

/**
 * Reactivate account
 */
export async function reactivateAccount(db: DbClient, userId: string): Promise<void> {
  try {
    await writeUserStateChange(db as Pool, userId, { account_status: 'active' });

    // Log billing event
    const organizationIdReactivate = await resolveOrganizationId(db as Pool, userId);
    await db.query(
      `INSERT INTO billing_events (user_id, organization_id, event_type, metadata)
       VALUES ($1, $2, 'account_reactivated', '{}')`,
      [userId, organizationIdReactivate]
    );

    console.log(`User ${userId} reactivated`);
  } catch (error) {
    throw new BillingServiceError(
      `Failed to reactivate account: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'REACTIVATE_FAILED'
    );
  }
}

/**
 * Calculate monthly AI billing for platform key users
 * Returns total cost for users who used platform OpenRouter key
 */
export async function calculateMonthlyAiBilling(
  db: DbClient,
  userId: string,
  periodStart: string,
  periodEnd: string
): Promise<{ totalCost: number; requestCount: number }> {
  try {
    // ai_usage_logs and apps are per-region runtime tables — a user may
    // have apps in multiple regions, so sum across every configured region.
    let totalCost = 0;
    let requestCount = 0;
    for (const region of Object.keys(config.runtimeDb.urlsByRegion)) {
      const runtimePool = getRuntimeDbPool(config.runtimeDb, region);
      const result = await runtimePool.query(
        `SELECT COUNT(*) as requests, COALESCE(SUM(cost_usd), 0) as total_cost
         FROM ai_usage_logs
         WHERE app_id IN (SELECT id FROM apps WHERE owner_id = $1)
           AND key_type = 'platform'
           AND charged_to_user = true
           AND DATE(created_at) >= $2
           AND DATE(created_at) <= $3`,
        [userId, periodStart, periodEnd]
      );
      totalCost += parseFloat(result.rows[0].total_cost);
      requestCount += parseInt(result.rows[0].requests, 10);
    }

    return { totalCost, requestCount };
  } catch (error) {
    throw new BillingServiceError(
      `Failed to calculate AI billing: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'AI_BILLING_FAILED'
    );
  }
}

/**
 * Mark AI usage records as billed to prevent double-charging
 */
export async function markAiUsageAsBilled(
  db: DbClient,
  userId: string,
  periodStart: string,
  periodEnd: string
): Promise<void> {
  try {
    // ai_usage_logs and apps are per-region runtime tables — mark billed
    // across every configured region.
    for (const region of Object.keys(config.runtimeDb.urlsByRegion)) {
      const runtimePool = getRuntimeDbPool(config.runtimeDb, region);
      await runtimePool.query(
        `UPDATE ai_usage_logs
         SET request_metadata = jsonb_set(
           COALESCE(request_metadata, '{}'),
           '{billed}',
           'true'
         )
         WHERE app_id IN (SELECT id FROM apps WHERE owner_id = $1)
           AND key_type = 'platform'
           AND charged_to_user = true
           AND DATE(created_at) >= $2
           AND DATE(created_at) <= $3
           AND (request_metadata->>'billed' IS NULL OR request_metadata->>'billed' = 'false')`,
        [userId, periodStart, periodEnd]
      );
    }
  } catch (error) {
    throw new BillingServiceError(
      `Failed to mark AI usage as billed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'MARK_BILLED_FAILED'
    );
  }
}

/**
 * Get spending cap status for a user.
 * Returns cap amount, current overage spend, and remaining capacity.
 */
export async function getSpendingCapStatus(
  db: DbClient,
  userId: string
): Promise<{ capUsd: number | null; overageSpentUsd: number; remainingUsd: number | null; isAtCap: boolean }> {
  const userResult = await db.query(
    `SELECT pu.spending_cap_usd, pu.plan_id, p.max_ai_credits_usd, p.default_spending_cap_usd
     FROM platform_users pu
     JOIN plans p ON pu.plan_id = p.id
     WHERE pu.id = $1`,
    [userId]
  );

  if (userResult.rows.length === 0) {
    return { capUsd: null, overageSpentUsd: 0, remainingUsd: null, isAtCap: false };
  }

  const row = userResult.rows[0];
  const capUsd = row.spending_cap_usd !== null
    ? parseFloat(row.spending_cap_usd)
    : (row.default_spending_cap_usd !== null ? parseFloat(row.default_spending_cap_usd) : null);

  if (capUsd === null) {
    // No spending cap (playground or enterprise)
    return { capUsd: null, overageSpentUsd: 0, remainingUsd: null, isAtCap: false };
  }

  const includedCredits = parseFloat(row.max_ai_credits_usd);
  const totalUsed = await getAiCreditsUsed(db, userId, false);
  const overageSpentUsd = Math.max(0, totalUsed - includedCredits);
  const remainingUsd = Math.max(0, capUsd - overageSpentUsd);

  return {
    capUsd,
    overageSpentUsd,
    remainingUsd,
    isAtCap: overageSpentUsd >= capUsd,
  };
}

/**
 * Enforce expired grace periods — suspend accounts past their 7-day window.
 * Called nightly by cron.
 */
export async function enforceExpiredGracePeriods(db: Pool): Promise<void> {
  try {
    // subscriptions, platform_users are platform-tier — stay on db.
    // app_subscriptions is per-region runtime tier — handled per-region below.

    // Find platform subscriptions past grace period (subscriptions is platform-tier)
    const result = await db.query(
      `SELECT s.user_id, s.stripe_subscription_id
       FROM subscriptions s
       WHERE s.status = 'past_due'
         AND s.grace_period_ends_at IS NOT NULL
         AND s.grace_period_ends_at < now()`
    );

    for (const row of result.rows) {
      // Grace expiry should *downgrade*, not suspend. Suspending blocks login/API
      // entirely, which is too harsh for a card decline — the user should still
      // be able to sign in, update payment, and resubscribe.
      await db.query(
        `UPDATE subscriptions SET status = 'canceled', updated_at = now()
         WHERE stripe_subscription_id = $1`,
        [row.stripe_subscription_id]
      );

      // Downgrade to playground plan (platform_users is platform-tier)
      await writeUserStateChange(db, row.user_id, { plan_id: 'playground', spending_cap_usd: null });
      await invalidateUserAppLimits(db, row.user_id);

      // Best-effort: notify the user the payment failed and they were downgraded.
      try {
        const emailResult = await db.query(
          'SELECT email FROM platform_users WHERE id = $1',
          [row.user_id]
        );
        if (emailResult.rows.length > 0) {
          await sendBillingEmail(emailResult.rows[0].email, 'payment_failed', {}).catch((err) =>
            console.error('Failed to send downgrade email:', err),
          );
        }
      } catch (err) {
        console.error('Failed to look up email for grace-expiry notification:', err);
      }
    }

    if (result.rows.length > 0) {
      console.log(`Enforced grace period expiry for ${result.rows.length} subscriptions`);
    }

    // Find Connect subscriptions past grace period across every region
    // (app_subscriptions is runtime-tier).
    let connectTotal = 0;
    for (const region of Object.keys(config.runtimeDb.urlsByRegion)) {
      const runtimePool = getRuntimeDbPool(config.runtimeDb, region);
      const connectResult = await runtimePool.query(
        `SELECT id, stripe_subscription_id
         FROM app_subscriptions
         WHERE status = 'past_due'
           AND grace_period_ends_at IS NOT NULL
           AND grace_period_ends_at < now()`
      );

      for (const row of connectResult.rows) {
        await runtimePool.query(
          `UPDATE app_subscriptions SET status = 'canceled', updated_at = now()
           WHERE id = $1`,
          [row.id]
        );
      }
      connectTotal += connectResult.rows.length;
    }

    if (connectTotal > 0) {
      console.log(`Enforced grace period expiry for ${connectTotal} app subscriptions`);
    }
  } catch (error) {
    console.error('Failed to enforce grace period expiry:', error);
  }
}
