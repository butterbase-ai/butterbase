// services/control-api/src/plugins/quota-enforcement.ts
import fp from 'fastify-plugin';
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import type { Pool } from 'pg';
import { getCurrentUsage, getAiCreditsUsed, getStorageUsed, type MeterType } from '../services/usage-metering.js';
import { sendBillingEmail, type BillingEmailTemplate } from '../services/auth/email-service.js';
import { quotaErrors } from '../utils/quota-errors.js';
import { getRedisClient } from '../services/redis.js';
import { writeUserStateChange } from '../services/state-outbox.js';
import { readOrgBillingState, applyLease, burnLease } from '../services/org-billing-state.js';
import { requestLeaseFromPlatform } from '../services/lease-client.js';
import { assertRegionConfig } from '../config.js';
import { resolveOrganizationId } from '../services/org-resolver.js';

// Cache for plan limits (5 minute TTL)
const PLAN_CACHE_TTL = 300; // 5 minutes

function requireEnvNumber(name: string): number {
  const raw = process.env[name];
  if (raw == null || raw === '') {
    throw new Error(`${name} environment variable is required`);
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
}

async function refillLease(
  fastify: any,
  runtimePool: Pool,
  userId: string,
  organizationId: string,
  region: string
): Promise<{ amountGranted: number }> {
  const platformRegion = process.env.BUTTERBASE_PLATFORM_REGION;
  const ttl = requireEnvNumber('BUTTERBASE_LEASE_TTL_SECONDS');
  const leaseSize = requireEnvNumber('BUTTERBASE_LEASE_SIZE_USD');

  if (platformRegion === region) {
    const { grantLease } = await import('../services/lease-service.js');
    const grant = await grantLease(fastify.controlDb, { userId, organizationId, region, amountUsd: leaseSize, ttlSeconds: ttl });
    if (grant.amountGranted > 0) await applyLease(runtimePool, userId, grant.amountGranted, grant.expiresAt);
    return { amountGranted: grant.amountGranted };
  }

  const platformUrl = process.env.CONTROL_PLANE_URL_PLATFORM_REGION;
  if (!platformUrl) throw new Error('CONTROL_PLANE_URL_PLATFORM_REGION required');
  const grant = await requestLeaseFromPlatform({
    userId,
    organizationId,
    amountUsd: leaseSize,
    platformControlApiUrl: platformUrl,
  });
  if (grant.amountGranted > 0) await applyLease(runtimePool, userId, grant.amountGranted, grant.expiresAt);
  return { amountGranted: grant.amountGranted };
}

export interface PlanLimits {
  maxStorageGb: number;
  maxAiCreditsUsd: number;
  aiCreditsLifetime: boolean;
  maxLambdaInvocations: number;
  maxBandwidthGb: number;
  maxDbSizeGb: number;
  maxMau: number;
  defaultSpendingCapUsd: number | null;
  aiOverageRateUsd: number | null;
  maxRequestsPerMin: number;
  maxRealtimeListenersPerApp: number;
  statementTimeoutMs: number;
  kvMaxOpsPerSec: number;
  kvMaxStorageBytes: number;
  kvMaxKeysTotal: number;
  kvMaxValueBytes: number;
}

declare module 'fastify' {
  interface FastifyContextConfig {
    skipQuota?: boolean;
    meterType?: MeterType;
  }
}

const quotaEnforcementPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    // Skip quota check for public routes or routes with skipQuota flag
    if (request.routeOptions.config?.public || request.routeOptions.config?.skipQuota) {
      return;
    }

    // Skip if no auth context (will be handled by auth plugin)
    if (!request.auth?.userId) {
      return;
    }

    const userId = request.auth.userId;

    // Resolve the organization that owns this user so meter queries
    // include apps created by all org members, not just this caller.
    // Fail loud — a missing org is data corruption, not a soft error.
    const organizationId = await resolveOrganizationId(fastify.controlDb, userId);

    try {
      // Get user's account status and plan from local runtime DB cache
      const region = assertRegionConfig().instanceRegion;
      const runtimePool = fastify.runtimeDb(region);

      let state = await readOrgBillingState(runtimePool, userId);

      // Cold-start fallback: seed runtime cache from platform DB
      if (!state) {
        const r = await fastify.controlDb.query(
          `SELECT o.account_status, o.plan_id, o.spending_cap_usd
           FROM organizations o
           JOIN platform_users u ON u.personal_organization_id = o.id
           WHERE u.id = $1`,
          [userId]
        );
        if (r.rows.length === 0) {
          return reply.code(401).send({ error: 'User not found' });
        }
        await runtimePool.query(
          `INSERT INTO user_billing_state (user_id, account_status, plan_id, spending_cap_usd, last_outbox_version)
           VALUES ($1, $2, $3, $4, 0)
           ON CONFLICT (user_id) DO NOTHING`,
          [userId, r.rows[0].account_status, r.rows[0].plan_id, r.rows[0].spending_cap_usd]
        );
        state = await readOrgBillingState(runtimePool, userId);
      }

      const account_status = state!.account_status ?? undefined;
      const plan_id = state!.plan_id ?? undefined;

      // Check account status
      if (account_status === 'suspended') {
        return reply.code(403).send(quotaErrors.accountSuspended());
      }

      if (account_status === 'soft_locked') {
        // Soft-locked: allow SELECT and DELETE only
        const method = request.method.toUpperCase();
        const isReadOrDelete = method === 'GET' || method === 'DELETE';

        if (!isReadOrDelete) {
          return reply.code(402).send(quotaErrors.accountSoftLocked());
        }
      }

      // Get plan limits (cached, backed by DB)
      const limits = await getPlanLimits(fastify.controlDb, plan_id!);
      const isPlayground = plan_id === 'playground';

      // Determine which meter to check based on route
      const meterType = determineMeterType(request);
      if (!meterType) {
        return; // No quota check needed for this route
      }

      // For AI routes, check dollar-based credits with consumption order:
      // 1. Included monthly credits  2. Prepaid top-ups  3. Overage (against spending cap)
      if (meterType === 'ai_tokens') {
        const includedCredits = limits.maxAiCreditsUsd;
        if (includedCredits === -1) return; // unlimited (enterprise)

        // Playground uses lifetime credits; paid tiers use monthly billing period
        const creditsUsed = await getAiCreditsUsed(fastify.controlDb, organizationId, limits.aiCreditsLifetime);
        const isPlayground = plan_id === 'playground';

        if (creditsUsed >= includedCredits) {
          if (isPlayground) {
            // Playground: hard gate AI only — no soft-lock, everything else works
            return reply.code(402).send(quotaErrors.aiCreditsExhausted(creditsUsed, includedCredits));
          }

          // Paid tier: burn against the local lease (refilled from platform top-up balance).
          // Per-request reservation; actual usage is metered post-call.
          const costUsd = parseFloat(process.env.BUTTERBASE_AI_REQUEST_RESERVATION_USD ?? '0.01');

          let burn = await burnLease(runtimePool, userId, costUsd);
          if (!burn.allowed) {
            await refillLease(fastify, runtimePool, userId, organizationId, region);
            burn = await burnLease(runtimePool, userId, costUsd);
            if (!burn.allowed) {
              const spendingCap = state!.spending_cap_usd !== null
                ? parseFloat(String(state!.spending_cap_usd))
                : limits.defaultSpendingCapUsd ?? 20;
              return reply.code(402).send(
                quotaErrors.spendingCapReached(creditsUsed - includedCredits, spendingCap, limits.aiOverageRateUsd)
              );
            }
          }

          // Below-threshold proactive refill (fire-and-forget)
          const threshold = requireEnvNumber('BUTTERBASE_LEASE_REFILL_THRESHOLD_USD');
          if (burn.allowed && burn.remaining < threshold) {
            void refillLease(fastify, runtimePool, userId, organizationId, region).catch((e) => {
              fastify.log.warn({ e }, 'lease refill failed');
            });
          }

          // Allowed — notify once (AI is a SOFT limit)
          await notifyLimitOnce(fastify.controlDb, userId, 'ai_credits', 'overage_warning', '100', creditsUsed, includedCredits);
          reply.header('X-Butterbase-AI-Credits', `Using top-up lease ($${burn.remaining.toFixed(2)} remaining)`);
          return;
        }

        // Warn at 80% of included credits — AI is a SOFT limit
        if (creditsUsed >= includedCredits * 0.8) {
          const percentage = Math.round((creditsUsed / includedCredits) * 100);
          reply.header('X-Butterbase-Usage-Warning', `ai_credits at ${percentage}% of included credits`);
          await notifyLimitOnce(fastify.controlDb, userId, 'ai_credits', 'soft_limit_warning', '80', creditsUsed, includedCredits);
        }
        return;
      }

      // For all other meters, check via usage counters or source-of-truth queries
      const currentUsage = meterType === 'storage_bytes'
        ? await getStorageUsed(fastify.controlDb, organizationId)
        : await getCurrentUsage(fastify.controlDb, organizationId, meterType, undefined, userId);
      const limit = getLimitForMeter(limits, meterType);

      // Check if limit is unlimited (-1)
      if (limit === -1) {
        return;
      }

      const meterIsSoft = isSoftMeter(meterType);

      // Check if limit exceeded
      if (currentUsage >= limit) {
        if (isPlayground) {
          // Playground users get soft-locked when exceeding any non-AI resource limit.
          // Email them once so they understand the lockout and how to recover.
          if (account_status === 'active') {
            await writeUserStateChange(fastify.controlDb, userId, { account_status: 'soft_locked' }).catch((err) => {
              fastify.log.error({ err, userId }, 'auto-soft-lock outbox write failed');
            });
          }
          await notifyLimitOnce(fastify.controlDb, userId, meterType, 'hard_limit_exceeded', '100', currentUsage, limit);

          return reply.code(429).send(quotaErrors.planLimitExceeded(meterType, currentUsage, limit));
        } else {
          // Paid users: behaviour depends on whether this meter is soft (overage billed) or hard (must upgrade).
          if (meterIsSoft) {
            await notifyLimitOnce(fastify.controlDb, userId, meterType, 'overage_warning', '100', currentUsage, limit);
            reply.header('X-Butterbase-Usage-Warning', `${meterType} exceeded plan limit (overage will be billed)`);
            return;
          } else {
            await notifyLimitOnce(fastify.controlDb, userId, meterType, 'hard_limit_exceeded', '100', currentUsage, limit);
            reply.header('X-Butterbase-Usage-Warning', `${meterType} exceeded plan limit — upgrade required`);
            return;
          }
        }
      }

      // Add warning header + email at 80%
      if (currentUsage >= limit * 0.8) {
        const percentage = Math.round((currentUsage / limit) * 100);
        reply.header('X-Butterbase-Usage-Warning', `${meterType} at ${percentage}% of plan limit`);
        await notifyLimitOnce(
          fastify.controlDb,
          userId,
          meterType,
          meterIsSoft ? 'soft_limit_warning' : 'hard_limit_warning',
          '80',
          currentUsage,
          limit,
        );
      }
    } catch (error) {
      fastify.log.error({ err: error }, 'Quota enforcement error');
      // Don't block request on quota check failure
      return;
    }
  });
};

// Helper functions

export const FREE_PLAN_DEFAULTS: PlanLimits = {
  maxStorageGb: 1,
  get maxAiCreditsUsd() { return requireEnvNumber('DEFAULT_FREE_PLAN_AI_CREDITS_USD'); },
  aiCreditsLifetime: true,
  maxLambdaInvocations: 50000,
  maxBandwidthGb: 5,
  maxDbSizeGb: 0.5,
  maxMau: 10000,
  defaultSpendingCapUsd: null,
  aiOverageRateUsd: null,
  maxRequestsPerMin: 300,
  maxRealtimeListenersPerApp: 20,
  statementTimeoutMs: 15000,
  kvMaxOpsPerSec: 50,
  kvMaxStorageBytes: 10 * 1024 * 1024,
  kvMaxKeysTotal: 100_000,
  kvMaxValueBytes: 256 * 1024,
};

export async function getPlanLimits(db: Pool, planId: string): Promise<PlanLimits> {
  const cacheKey = `plan:${planId}`;

  // Try cache first
  const cached = await getRedisClient().get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }

  // Fetch from database
  try {
    const result = await db.query(
      `SELECT max_storage_gb, max_ai_credits_usd, ai_credits_lifetime,
              max_lambda_invocations, max_bandwidth_gb, max_db_size_gb, max_mau,
              default_spending_cap_usd, ai_overage_rate_usd,
              max_requests_per_min, max_realtime_listeners_per_app,
              statement_timeout_ms, kv_max_ops_per_sec, kv_max_storage_bytes,
              kv_max_keys_total, kv_max_value_bytes
       FROM plans WHERE id = $1`,
      [planId]
    );

    if (result.rows.length === 0) {
      return FREE_PLAN_DEFAULTS;
    }

    const row = result.rows[0];
    const limits: PlanLimits = {
      maxStorageGb: parseFloat(row.max_storage_gb),
      maxAiCreditsUsd: parseFloat(row.max_ai_credits_usd),
      aiCreditsLifetime: row.ai_credits_lifetime,
      maxLambdaInvocations: row.max_lambda_invocations,
      maxBandwidthGb: parseFloat(row.max_bandwidth_gb),
      maxDbSizeGb: parseFloat(row.max_db_size_gb),
      maxMau: row.max_mau,
      defaultSpendingCapUsd: row.default_spending_cap_usd !== null ? parseFloat(row.default_spending_cap_usd) : null,
      aiOverageRateUsd: row.ai_overage_rate_usd !== null ? parseFloat(row.ai_overage_rate_usd) : null,
      maxRequestsPerMin: row.max_requests_per_min,
      maxRealtimeListenersPerApp: row.max_realtime_listeners_per_app,
      statementTimeoutMs: row.statement_timeout_ms,
      kvMaxOpsPerSec: row.kv_max_ops_per_sec,
      kvMaxStorageBytes: row.kv_max_storage_bytes,
      kvMaxKeysTotal: row.kv_max_keys_total,
      kvMaxValueBytes: row.kv_max_value_bytes,
    };

    // Cache for 5 minutes
    await getRedisClient().setex(cacheKey, PLAN_CACHE_TTL, JSON.stringify(limits));

    return limits;
  } catch {
    // Fallback to free-plan defaults if DB query fails
    return FREE_PLAN_DEFAULTS;
  }
}

/**
 * Resources where overages are allowed (paid users keep going, billed at overage rate).
 * All others are hard limits (user is blocked, must upgrade).
 */
const SOFT_METERS = new Set<string>(['ai_credits', 'bandwidth_bytes']);

export function isSoftMeter(meter: string): boolean {
  return SOFT_METERS.has(meter);
}

/**
 * Send a limit-related notification email at most once per (user, meter, threshold, billing period).
 * Threshold is '80' for warning emails or '100' for exceeded emails so a user can receive both
 * within the same period without dedup collision.
 */
async function notifyLimitOnce(
  db: Pool,
  userId: string,
  meter: string,
  template: BillingEmailTemplate,
  threshold: '80' | '100',
  current: number,
  limit: number
): Promise<void> {
  const periodStart = new Date();
  const periodKey = `${periodStart.getFullYear()}-${String(periodStart.getMonth() + 1).padStart(2, '0')}`;
  const notifKey = `limit_notif:${userId}:${meter}:${threshold}:${periodKey}`;

  try {
    const wasSet = await getRedisClient().set(notifKey, '1', 'EX', 35 * 24 * 60 * 60, 'NX');
    if (!wasSet) return; // Already notified this period

    const emailResult = await db.query(
      'SELECT email FROM platform_users WHERE id = $1',
      [userId]
    );
    if (emailResult.rows.length === 0) return;

    const isCurrency = meter === 'ai_credits';
    await sendBillingEmail(emailResult.rows[0].email, template, {
      meter,
      threshold,
      percentage: threshold,
      current: isCurrency ? `$${current.toFixed(2)}` : String(current),
      limit: isCurrency ? `$${limit.toFixed(2)}` : String(limit),
    }).catch((err) => {
      console.error('Failed to send limit notification email:', err);
    });
  } catch {
    // Don't block on notification failure
  }
}

function determineMeterType(request: FastifyRequest): MeterType | null {
  const path = request.url;

  // AI endpoints — check before generic /v1/ match
  if (path.includes('/chat/completions') || path.includes('/embeddings')) {
    return 'ai_tokens';
  }

  // Storage endpoints
  if (path.includes('/storage')) {
    return 'storage_bytes';
  }

  // Lambda invocations
  if (path.includes('/fn/') || path.includes('/functions')) {
    return 'lambda_invocations';
  }

  return null;
}

function getLimitForMeter(limits: PlanLimits, meterType: MeterType): number {
  switch (meterType) {
    case 'storage_bytes':
      return limits.maxStorageGb === -1 ? -1 : limits.maxStorageGb * 1024 * 1024 * 1024;
    case 'ai_tokens':
      // AI tokens are now handled via dollar-based credits in the main hook
      return -1;
    case 'lambda_invocations':
      return limits.maxLambdaInvocations;
    case 'bandwidth_bytes':
      return limits.maxBandwidthGb === -1 ? -1 : limits.maxBandwidthGb * 1024 * 1024 * 1024;
    case 'mau':
      return limits.maxMau;
    case 'api_calls':
      return -1; // No longer a plan limit
    default:
      return -1;
  }
}

export default fp(quotaEnforcementPlugin, {
  name: 'quota-enforcement',
  dependencies: ['auth', 'database'],
});
