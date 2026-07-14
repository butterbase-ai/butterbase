// services/control-api/src/routes/billing.ts
import type { FastifyInstance } from 'fastify';
import { isHttpError } from '../services/error-handler.js';
import { z } from 'zod';
import { getCurrentUsage, getAiCreditsUsed, getStorageUsed, getDbSize, getMAU, getCreditsBalance, type MeterType } from '../services/usage-metering.js';
import { getSpendingCapStatus } from '../services/billing-service.js';
import { resolveOrganizationId } from '../services/org-resolver.js';

// Stripe-backed billing functions live in the cloud overlay. In OSS mode they
// resolve to no-op / unavailable stubs and Stripe-specific endpoints return
// 501 not-implemented.
type StripeOverlay = {
  createCheckoutSession: (...args: any[]) => Promise<any>;
  createCustomerPortalSession: (...args: any[]) => Promise<any>;
  handleWebhook: (...args: any[]) => Promise<any>;
  verifyWebhookSignature: (...args: any[]) => any;
  purchaseTopupPack: (...args: any[]) => Promise<any>;
  raiseSpendingCap: (...args: any[]) => Promise<any>;
  cancelAllUserSubscriptions: (...args: any[]) => Promise<any>;
  StripeServiceError: new (...args: any[]) => Error & { code: string; message: string };
};
type SponsorOverlay = {
  redeemSponsorCode: (...args: any[]) => Promise<any>;
  SponsorCodeError: new (...args: any[]) => Error & { code: string; message: string };
};
async function loadStripeOverlay(): Promise<StripeOverlay | null> {
  try {
    // @ts-expect-error — overlay path resolved at runtime
    return await import('../../../../cloud-overlays/dist/cloud-overlays/billing/stripe/stripe-service.js');
  } catch { return null; }
}
async function loadSponsorOverlay(): Promise<SponsorOverlay | null> {
  try {
    // @ts-expect-error — overlay path resolved at runtime
    return await import('../../../../cloud-overlays/dist/cloud-overlays/billing/sponsor-codes.js');
  } catch { return null; }
}
import { requireUserId } from '../utils/require-auth.js';
import { apiError } from '../utils/api-error.js';
import * as neonClient from '../services/neon-client.js';
import * as DeploymentService from '../services/deployment.service.js';
import { deleteObject } from '../services/s3.js';
import { config, assertRegionConfig } from '../config.js';

const checkoutSchema = z.object({
  planId: z.string(),
  successUrl: z.string().url().optional(),
  cancelUrl: z.string().url().optional(),
});

const usageQuerySchema = z.object({
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  meterType: z.enum(['api_calls', 'storage_bytes', 'ai_tokens', 'lambda_invocations', 'bandwidth_bytes']).optional(),
});

export async function billingRoutes(app: FastifyInstance) {
  const dashboardUrl = process.env.DASHBOARD_URL || 'http://localhost:3000';

  const stripe = await loadStripeOverlay();
  const sponsor = await loadSponsorOverlay();
  const notImpl = (reply: any) => reply.code(501).send({ error: 'billing_not_implemented', message: 'Stripe billing is not configured in this deployment.' });
  const createCheckoutSession = stripe?.createCheckoutSession ?? (async () => { throw new Error('not_implemented'); });
  const createCustomerPortalSession = stripe?.createCustomerPortalSession ?? (async () => { throw new Error('not_implemented'); });
  const handleWebhook = stripe?.handleWebhook ?? (async () => { throw new Error('not_implemented'); });
  const verifyWebhookSignature = stripe?.verifyWebhookSignature ?? (() => { throw new Error('not_implemented'); });
  const purchaseTopupPack = stripe?.purchaseTopupPack ?? (async () => { throw new Error('not_implemented'); });
  const raiseSpendingCap = stripe?.raiseSpendingCap ?? (async () => { throw new Error('not_implemented'); });
  const cancelAllUserSubscriptions = stripe?.cancelAllUserSubscriptions ?? (async () => { throw new Error('not_implemented'); });
  class _NoStripeError extends Error { code = 'not_implemented'; static [Symbol.hasInstance]() { return false; } }
  class _NoSponsorError extends Error { code = 'not_implemented'; static [Symbol.hasInstance]() { return false; } }
  const StripeServiceError = stripe?.StripeServiceError ?? _NoStripeError;
  const redeemSponsorCode = sponsor?.redeemSponsorCode ?? (async () => { throw new Error('not_implemented'); });
  const SponsorCodeError = sponsor?.SponsorCodeError ?? _NoSponsorError;
  void notImpl; // reserved for future explicit 501s

  // Get current billing info (plan, usage, subscription status)
  app.get('/dashboard/billing', async (request, reply) => {
    const userId = requireUserId(request);

    // Optional ?org_id=<uuid>: view billing for a specific org the caller is a
    // member of. Falls back to the caller's personal org when absent so legacy
    // callers keep working. Membership is enforced — non-members get 403.
    const query = (request.query ?? {}) as { org_id?: string };
    const requestedOrgId = query.org_id;
    let targetOrgId: string | null = null;
    if (requestedOrgId) {
      const membership = await app.controlDb.query(
        `SELECT 1 FROM organization_members
         WHERE organization_id = $1 AND user_id = $2
         LIMIT 1`,
        [requestedOrgId, userId]
      );
      if (membership.rows.length === 0) {
        return reply.code(403).send({ error: 'Not a member of the requested organization' });
      }
      targetOrgId = requestedOrgId;
    }

    const region = assertRegionConfig().instanceRegion;
    try {
      // Get billing state for the resolved org: either the ?org_id path arg
      // (membership already checked above) or the caller's personal org.
      const userResult = await app.controlDb.query(
        `SELECT o.id AS org_id, o.plan_id, o.stripe_customer_id, o.billing_period_start, o.account_status,
                p.name as plan_name, p.price_monthly_cents,
                p.max_storage_gb, p.max_ai_credits_usd, p.ai_credits_lifetime,
                p.max_lambda_invocations, p.max_db_size_gb, p.max_bandwidth_gb, p.max_mau,
                p.max_projects, p.overage_rates, p.features
         FROM platform_users pu
         JOIN organizations o ON o.id = COALESCE($2::uuid, pu.personal_organization_id)
         JOIN plans p ON p.id = o.plan_id
         WHERE pu.id = $1`,
        [userId, targetOrgId]
      );

      if (userResult.rows.length === 0) {
        return reply.code(404).send({ error: 'User not found' });
      }

      const user = userResult.rows[0];
      // Resolve once — used for subscription queries and usage meter queries below.
      const billingOrgId: string = user.org_id;

      // Get active subscription — subscriptions is a controlDb (platform) table
      const subscriptionResult = await app.controlDb.query(
        `SELECT stripe_subscription_id, status, current_period_start, current_period_end, cancel_at_period_end
         FROM subscriptions
         WHERE organization_id = $1 AND status IN ('active', 'trialing', 'past_due')
         ORDER BY created_at DESC
         LIMIT 1`,
        [billingOrgId]
      );

      let subscription = subscriptionResult.rows.length > 0 ? subscriptionResult.rows[0] : null;

      // If the org is on a paid plan but has no live subscription, surface the
      // most-recent canceled subscription so the dashboard can show "Plan ends
      // on …" instead of hiding the subscription card entirely. This makes
      // payment-failure / orphan-sub states visible to the user.
      if (!subscription && user.plan_id && user.plan_id !== 'playground') {
        const lastCanceled = await app.controlDb.query(
          `SELECT stripe_subscription_id, status, current_period_start, current_period_end, cancel_at_period_end
           FROM subscriptions
           WHERE organization_id = $1 AND status = 'canceled'
           ORDER BY current_period_end DESC NULLS LAST, updated_at DESC
           LIMIT 1`,
          [billingOrgId],
        );
        if (lastCanceled.rows.length > 0) {
          subscription = lastCanceled.rows[0];
        }
      }

      // Get current usage for all meters — these helpers query runtime tables
      // (ai_usage_logs, apps, storage_objects, app_users, app_db_connections)
      const isLifetime = user.ai_credits_lifetime;
      const aiCreditsUsed = await getAiCreditsUsed(app.runtimeDb(region), billingOrgId, isLifetime);
      // Project count must aggregate across ALL regions. org_app_index is the
      // authoritative cross-region index on controlDb — counting `apps` on the
      // local runtimeDb undercounts users with apps in other regions (and shows
      // 0 when the local region has no apps for the user).
      const projectCountResult = await app.controlDb.query(
        'SELECT COUNT(*)::int as count FROM org_app_index WHERE organization_id = $1',
        [billingOrgId]
      );

      const usage = {
        storage_bytes: await getStorageUsed(app.runtimeDb(region), billingOrgId),
        ai_credits_usd: aiCreditsUsed,
        lambda_invocations: await getCurrentUsage(app.runtimeDb(region), billingOrgId, 'lambda_invocations'),
        bandwidth_bytes: await getCurrentUsage(app.runtimeDb(region), billingOrgId, 'bandwidth_bytes'),
        db_size_bytes: await getDbSize(app.runtimeDb(region), billingOrgId),
        mau: await getMAU(app.runtimeDb(region), billingOrgId),
        project_count: projectCountResult.rows[0].count,
      };

      const maxAiCreditsUsd = parseFloat(user.max_ai_credits_usd);
      const maxStorageGb = parseFloat(user.max_storage_gb);
      const maxBandwidthGb = parseFloat(user.max_bandwidth_gb);
      const maxDbSizeGb = parseFloat(user.max_db_size_gb);
      const maxMau = user.max_mau;
      const maxProjects = user.max_projects;

      // Calculate usage percentages (only for non-unlimited limits)
      const pct = (current: number, limit: number) => limit > 0 ? (current / limit) * 100 : 0;
      const usagePercentages = {
        storage_bytes: maxStorageGb > 0 ? pct(usage.storage_bytes, maxStorageGb * 1024 * 1024 * 1024) : 0,
        ai_credits: maxAiCreditsUsd > 0 ? pct(aiCreditsUsed, maxAiCreditsUsd) : 0,
        lambda_invocations: user.max_lambda_invocations > 0 ? pct(usage.lambda_invocations, user.max_lambda_invocations) : 0,
        bandwidth_bytes: maxBandwidthGb > 0 ? pct(usage.bandwidth_bytes, maxBandwidthGb * 1024 * 1024 * 1024) : 0,
        db_size_bytes: maxDbSizeGb > 0 ? pct(usage.db_size_bytes, maxDbSizeGb * 1024 * 1024 * 1024) : 0,
        mau: maxMau > 0 ? pct(usage.mau, maxMau) : 0,
        project_count: maxProjects > 0 ? pct(usage.project_count, maxProjects) : 0,
      };

      // Get AI usage breakdown (BYOK vs platform)
      const periodStart = user.billing_period_start || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      const periodEnd = new Date().toISOString().split('T')[0];

      // ai_usage_logs and apps are runtime tables — use runtimeDb
      const aiUsageResult = await app.runtimeDb(region).query(
        `SELECT
           key_type,
           COUNT(*) as requests,
           SUM(total_tokens) as tokens,
           SUM(cost_usd) as cost
         FROM ai_usage_logs
         WHERE app_id IN (SELECT id FROM apps WHERE organization_id = $1)
           AND DATE(created_at) >= $2
           AND DATE(created_at) <= $3
         GROUP BY key_type`,
        [billingOrgId, periodStart, periodEnd]
      );

      const aiUsageBreakdown = {
        byok: { requests: 0, tokens: 0, cost: 0 },
        platform: { requests: 0, tokens: 0, cost: 0 },
      };

      for (const row of aiUsageResult.rows) {
        const keyType = row.key_type as 'byok' | 'platform';
        aiUsageBreakdown[keyType] = {
          requests: parseInt(row.requests, 10),
          tokens: parseInt(row.tokens, 10),
          cost: parseFloat(row.cost),
        };
      }

      // Per-org billing balance (migration 093 + Phase 3b). Keyed on the
      // resolved billingOrgId, which honors ?org_id when the caller is a
      // member and otherwise defaults to their personal org.
      const credits = await getCreditsBalance(app.controlDb, billingOrgId);
      // getSpendingCapStatus reads platform_users+plans (controlDb) and ai_usage_logs (runtime);
      // FIXME: getSpendingCapStatus internally calls getAiCreditsUsed which hits runtimeDb tables
      // (ai_usage_logs, apps). The service function signature must be updated in a follow-on batch.
      const capStatus = await getSpendingCapStatus(app.controlDb, userId);
      const aiOverageRate = user.overage_rates?.ai_credits ?? null;

      const aiCreditsIncluded = maxAiCreditsUsd > 0 ? maxAiCreditsUsd : 0;
      const aiCreditsRemaining = Math.max(0, aiCreditsIncluded - aiCreditsUsed);

      return {
        plan: {
          id: user.plan_id,
          name: user.plan_name,
          price: user.price_monthly_cents,
          limits: {
            maxStorageGb: maxStorageGb,
            maxAiCreditsUsd: maxAiCreditsUsd,
            aiCreditsLifetime: isLifetime,
            maxLambdaInvocations: user.max_lambda_invocations,
            maxDbSizeGb: parseFloat(user.max_db_size_gb),
            maxBandwidthGb: maxBandwidthGb,
            maxMau: maxMau,
            maxProjects: maxProjects,
          },
          overageRates: user.overage_rates || {},
          features: user.features,
        },
        subscription: subscription ? {
          id: subscription.stripe_subscription_id,
          status: subscription.status,
          currentPeriodStart: subscription.current_period_start,
          currentPeriodEnd: subscription.current_period_end,
          cancelAtPeriodEnd: subscription.cancel_at_period_end,
        } : null,
        usage,
        usagePercentages,
        credits: {
          monthly_allowance_usd: credits.monthlyAllowanceUsd,
          topup_usd: credits.topupUsd,
          total_usd: credits.totalUsd,
        },
        // DEPRECATED — use credits.topup_usd; remove in next release.
        topupBalance: credits.topupUsd,
        aiCredits: {
          included: aiCreditsIncluded,
          used: aiCreditsUsed,
          remaining: aiCreditsRemaining,
          overage: {
            spent: capStatus.overageSpentUsd,
            cap: capStatus.capUsd,
            remaining: capStatus.remainingUsd,
            rate: aiOverageRate,
            isAtCap: capStatus.isAtCap,
          },
        },
        aiUsageBreakdown,
        accountStatus: user.account_status,
        billingPeriodStart: user.billing_period_start,
      };
    } catch (error) {
      if (isHttpError(error)) throw error;
      app.log.error({ err: error }, 'Failed to get billing info');
      return reply.code(500).send(apiError(error, 'Failed to retrieve billing information'));
    }
  });

  // Create Stripe checkout session
  app.post('/dashboard/billing/checkout', async (request, reply) => {
    const userId = requireUserId(request);

    try {
      const body = checkoutSchema.parse(request.body);

      const successUrl = body.successUrl || `${dashboardUrl}/billing/success`;
      const cancelUrl = body.cancelUrl || `${dashboardUrl}/billing`;

      const session = await createCheckoutSession(app.controlDb, {
        userId,
        planId: body.planId,
        successUrl,
        cancelUrl,
        organizationId: request.auth?.organizationId ?? null,
      });

      return { sessionId: session.sessionId, url: session.url };
    } catch (error) {
      if (isHttpError(error)) throw error;
      if (error instanceof z.ZodError) {
        return reply.code(400).send({ error: 'Invalid request', details: error.errors });
      }
      app.log.error({ err: error }, 'Failed to create checkout session');
      if (error instanceof StripeServiceError) {
        const httpStatus = error.code === 'USER_NOT_FOUND' ? 404
          : error.code === 'PLAN_NOT_FOUND' ? 404
          : error.code === 'INVALID_PLAN' ? 400
          : 500;
        return reply.code(httpStatus).send({ error: error.message, code: error.code });
      }
      return reply.code(500).send(apiError(error, 'Failed to create checkout session'));
    }
  });

  // Create Stripe customer portal session
  app.post('/dashboard/billing/portal', async (request, reply) => {
    const userId = requireUserId(request);

    try {
      const returnUrl = `${dashboardUrl}/billing`;

      const session = await createCustomerPortalSession(app.controlDb, {
        userId,
        returnUrl,
      });

      return { url: session.url };
    } catch (error) {
      if (isHttpError(error)) throw error;
      app.log.error({ err: error }, 'Failed to create portal session');
      if (error instanceof StripeServiceError) {
        const httpStatus = error.code === 'USER_NOT_FOUND' ? 404
          : error.code === 'NO_CUSTOMER' ? 400
          : 500;
        return reply.code(httpStatus).send({ error: error.message, code: error.code });
      }
      return reply.code(500).send(apiError(error, 'Failed to create customer portal session'));
    }
  });

  // Get usage history
  app.get('/dashboard/usage', async (request, reply) => {
    const userId = requireUserId(request);

    try {
      const organizationId = await resolveOrganizationId(app.controlDb, userId);
      const query = usageQuerySchema.parse(request.query);

      // Default to last 30 days
      const endDate = query.endDate || new Date().toISOString().split('T')[0];
      const startDate = query.startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

      // Build query based on meter type filter
      let sqlQuery = `
        SELECT meter_type, period_start, SUM(quantity) as total
        FROM usage_meters
        WHERE organization_id = $1 AND period_start >= $2 AND period_start <= $3
      `;
      const params: any[] = [organizationId, startDate, endDate];

      if (query.meterType) {
        sqlQuery += ` AND meter_type = $4`;
        params.push(query.meterType);
      }

      sqlQuery += ` GROUP BY meter_type, period_start ORDER BY period_start DESC, meter_type`;

      const result = await app.controlDb.query(sqlQuery, params);

      // Group by meter type
      const usageByMeter: Record<string, Array<{ date: string; quantity: number }>> = {};

      for (const row of result.rows) {
        if (!usageByMeter[row.meter_type]) {
          usageByMeter[row.meter_type] = [];
        }
        usageByMeter[row.meter_type].push({
          date: row.period_start,
          quantity: parseInt(row.total, 10),
        });
      }

      return {
        startDate,
        endDate,
        usage: usageByMeter,
      };
    } catch (error) {
      if (isHttpError(error)) throw error;
      if (error instanceof z.ZodError) {
        return reply.code(400).send({ error: 'Invalid query parameters', details: error.errors });
      }
      app.log.error({ err: error }, 'Failed to get usage history');
      return reply.code(500).send(apiError(error, 'Failed to retrieve usage history'));
    }
  });

  // Purchase a top-up credit pack
  app.post('/dashboard/billing/topup', async (request, reply) => {
    const userId = requireUserId(request);

    try {
      const body = z.object({
        amount: z.number().positive(),
      }).parse(request.body);

      const result = await purchaseTopupPack(app.controlDb, userId, body.amount);

      return { clientSecret: result.clientSecret, amount: body.amount };
    } catch (error) {
      if (isHttpError(error)) throw error;
      if (error instanceof z.ZodError) {
        return reply.code(400).send({ error: 'Invalid request', details: error.errors });
      }
      if (error instanceof StripeServiceError) {
        const httpStatus = error.code === 'USER_NOT_FOUND' ? 404
          : error.code === 'NO_CUSTOMER' ? 400
          : error.code === 'INVALID_AMOUNT' ? 400
          : 500;
        return reply.code(httpStatus).send({ error: error.message, code: error.code });
      }
      app.log.error({ err: error }, 'Failed to purchase top-up');
      return reply.code(500).send(apiError(error, 'Failed to purchase top-up pack'));
    }
  });

  // Get spending cap status
  app.get('/dashboard/billing/spending-cap', async (request, reply) => {
    const userId = requireUserId(request);

    try {
      const status = await getSpendingCapStatus(app.controlDb, userId);
      return status;
    } catch (error) {
      if (isHttpError(error)) throw error;
      app.log.error({ err: error }, 'Failed to get spending cap status');
      return reply.code(500).send(apiError(error, 'Failed to get spending cap status'));
    }
  });

  // Raise spending cap
  app.put('/dashboard/billing/spending-cap', async (request, reply) => {
    const userId = requireUserId(request);

    try {
      const body = z.object({
        raiseBy: z.number().positive().default(25),
      }).parse(request.body);

      const result = await raiseSpendingCap(app.controlDb, userId, body.raiseBy);

      return { newCap: result.newCap, previousCap: result.previousCap };
    } catch (error) {
      if (isHttpError(error)) throw error;
      if (error instanceof z.ZodError) {
        return reply.code(400).send({ error: 'Invalid request', details: error.errors });
      }
      if (error instanceof StripeServiceError) {
        const httpStatus = error.code === 'USER_NOT_FOUND' ? 404
          : error.code === 'NO_CUSTOMER' ? 400
          : error.code === 'INVALID_PLAN' ? 400
          : error.code === 'CARD_DECLINED' ? 402
          : 500;
        return reply.code(httpStatus).send({ error: error.message, code: error.code });
      }
      app.log.error({ err: error }, 'Failed to raise spending cap');
      return reply.code(500).send(apiError(error, 'Failed to raise spending cap'));
    }
  });

  // Get all plans (loaded from DB, not hardcoded)
  app.get('/dashboard/plans', async (request, reply) => {
    try {
      const result = await app.controlDb.query(
        `SELECT id, name, price_monthly_cents, max_projects, max_db_size_gb,
                max_storage_gb, max_bandwidth_gb, max_mau, max_ai_credits_usd,
                ai_overage_rate_usd, default_spending_cap_usd, max_lambda_invocations,
                overage_rates, features
         FROM plans ORDER BY price_monthly_cents ASC`
      );

      const plans = result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        priceMonthly: row.price_monthly_cents,
        maxProjects: row.max_projects,
        maxDbSizeGb: parseFloat(row.max_db_size_gb),
        maxStorageGb: parseFloat(row.max_storage_gb),
        maxBandwidthGb: parseFloat(row.max_bandwidth_gb),
        maxMau: row.max_mau,
        aiCreditsUsd: parseFloat(row.max_ai_credits_usd),
        aiOverageRate: row.ai_overage_rate_usd !== null ? parseFloat(row.ai_overage_rate_usd) : null,
        spendingCap: row.default_spending_cap_usd !== null ? parseFloat(row.default_spending_cap_usd) : null,
        maxLambdaInvocations: row.max_lambda_invocations,
        overageRates: row.overage_rates || {},
        features: row.features || {},
      }));

      return { plans };
    } catch (error) {
      if (isHttpError(error)) throw error;
      app.log.error({ err: error }, 'Failed to get plans');
      return reply.code(500).send(apiError(error, 'Failed to retrieve plans'));
    }
  });

  // Get onboarding status
  app.get('/dashboard/onboard/status', async (request, reply) => {
    const userId = requireUserId(request);

    try {
      const result = await app.controlDb.query(
        `SELECT pu.onboarding_completed, o.plan_id
         FROM platform_users pu
         LEFT JOIN organizations o ON o.id = pu.personal_organization_id
         WHERE pu.id = $1`,
        [userId]
      );

      if (result.rows.length === 0) {
        return reply.code(404).send({ error: 'User not found' });
      }

      return {
        onboardingCompleted: result.rows[0].onboarding_completed,
        planId: result.rows[0].plan_id,
      };
    } catch (error) {
      if (isHttpError(error)) throw error;
      app.log.error({ err: error }, 'Failed to get onboard status');
      return reply.code(500).send(apiError(error, 'Failed to get onboarding status'));
    }
  });

  // Complete onboarding (with or without sponsor code)
  app.post('/dashboard/onboard', async (request, reply) => {
    const userId = requireUserId(request);

    try {
      const body = z.object({
        sponsorCode: z.string().optional(),
        paymentMethodId: z.string().optional(),
      }).parse(request.body);

      let result: { plan: string; credit?: number } = { plan: 'playground' };

      if (body.sponsorCode && body.paymentMethodId) {
        // Redeem sponsor code
        const redemption = await redeemSponsorCode(
          app.controlDb, userId, body.sponsorCode, body.paymentMethodId
        );
        result = { plan: 'launch', credit: redemption.creditApplied };
      }

      // Mark onboarding as completed
      await app.controlDb.query(
        'UPDATE platform_users SET onboarding_completed = true WHERE id = $1',
        [userId]
      );

      return { onboarded: true, ...result };
    } catch (error) {
      if (isHttpError(error)) throw error;
      if (error instanceof z.ZodError) {
        return reply.code(400).send({ error: 'Invalid request', details: error.errors });
      }
      if (error instanceof SponsorCodeError) {
        return reply.code(400).send({ error: error.message, code: error.code });
      }
      app.log.error({ err: error }, 'Onboarding failed');
      return reply.code(500).send(apiError(error, 'Onboarding failed'));
    }
  });

  // Redeem sponsor code (from upgrade modal — user already has card)
  app.post('/dashboard/billing/sponsored-upgrade', async (request, reply) => {
    const userId = requireUserId(request);

    try {
      const body = z.object({
        sponsorCode: z.string(),
        paymentMethodId: z.string(),
      }).parse(request.body);

      const result = await redeemSponsorCode(
        app.controlDb, userId, body.sponsorCode, body.paymentMethodId
      );

      return { success: true, subscriptionId: result.subscriptionId, creditApplied: result.creditApplied };
    } catch (error) {
      if (isHttpError(error)) throw error;
      if (error instanceof z.ZodError) {
        return reply.code(400).send({ error: 'Invalid request', details: error.errors });
      }
      if (error instanceof SponsorCodeError) {
        return reply.code(400).send({ error: error.message, code: error.code });
      }
      app.log.error({ err: error }, 'Sponsored upgrade failed');
      return reply.code(500).send(apiError(error, 'Sponsored upgrade failed'));
    }
  });

  // Delete account — cleans up all external resources, then cascades DB deletion
  app.delete('/dashboard/account', async (request, reply) => {
    const userId = requireUserId(request);

    // User-delete guard (Plan 08): refuse if the caller is sole owner of any
    // non-personal org. Personal orgs get cleaned up after the user row is deleted.
    const ownedOrgs = await app.controlDb.query<{ id: string }>(
      `SELECT o.id
         FROM organizations o
        WHERE o.owner_id = $1
          AND o.personal = false
          AND NOT EXISTS (
            SELECT 1 FROM organization_members om
             WHERE om.organization_id = o.id
               AND om.role = 'owner'
               AND om.user_id <> $1
          )`,
      [userId],
    );
    if (ownedOrgs.rows.length > 0) {
      return reply.code(409).send({
        error: 'sole_owner_of_org',
        organizations: ownedOrgs.rows.map((r) => r.id),
        message: 'cannot delete account while sole owner of these organizations. Transfer ownership or delete the orgs first.',
      });
    }

    const region = assertRegionConfig().instanceRegion;
    try {
    // 1. Verify user exists — platform_users is a controlDb table
    const userResult = await app.controlDb.query(
      `SELECT pu.id, o.stripe_customer_id
       FROM platform_users pu
       LEFT JOIN organizations o ON o.id = pu.personal_organization_id
       WHERE pu.id = $1`,
      [userId]
    );
    if (userResult.rows.length === 0) {
      return reply.code(404).send({ error: 'User not found' });
    }

    // 2. Fetch all user's apps — apps is a runtime table
    // grep-gate-allow: account-deletion cleanup filters personally-owned apps only;
    // org-shared apps stay with the org after the user row is deleted.
    const appsResult = await app.runtimeDb(region).query(
      'SELECT id, db_name FROM apps WHERE owner_id = $1',
      [userId]
    );

    // 3. Clean up external resources for each app (best-effort)
    for (const appRow of appsResult.rows) {
      // 3a. Delete data plane database — app_db_connections is a runtime table
      if (config.neon.enabled) {
        const connRow = await app.runtimeDb(region).query<{ neon_project_id: string; neon_database_name: string }>(
          'SELECT neon_project_id, neon_database_name FROM app_db_connections WHERE app_id = $1',
          [appRow.id]
        );
        if (connRow.rows.length > 0) {
          try {
            await neonClient.withNeonProjectLock(connRow.rows[0].neon_project_id, () =>
              neonClient.deleteDatabase(connRow.rows[0].neon_project_id, connRow.rows[0].neon_database_name)
            );
          } catch (err) {
            app.log.warn({ err, appId: appRow.id }, 'Failed to delete Neon database during account deletion');
          }
        }
      } else {
        try {
          await app.dataPlaneDb.query(`DROP DATABASE IF EXISTS "${appRow.db_name}"`);
        } catch (err) {
          app.log.warn({ err, appId: appRow.id }, 'Failed to drop local database during account deletion');
        }
      }

      // 3b. Delete Cloudflare resources
      // FIXME: deleteAppCloudflareResources internally queries runtime tables (app_custom_domains, etc.)
      // but its signature accepts Pool; must be updated to accept runtimeDb in a follow-on batch.
      if (config.cloudflare.enabled) {
        try {
          await DeploymentService.deleteAppCloudflareResources(app.controlDb, appRow.id);
        } catch (err) {
          app.log.warn({ err, appId: appRow.id }, 'Failed to delete Cloudflare resources during account deletion');
        }
      }

      // 3c. Delete S3/R2 storage objects — storage_objects is a runtime table
      const storageResult = await app.runtimeDb(region).query(
        'SELECT key FROM storage_objects WHERE app_id = $1',
        [appRow.id]
      );
      for (const obj of storageResult.rows) {
        try {
          await deleteObject(obj.key);
        } catch (err) {
          app.log.warn({ err, key: obj.key }, 'Failed to delete storage object during account deletion');
        }
      }
    }

    // 4. Cancel all Stripe subscriptions
    try {
      await cancelAllUserSubscriptions(app.controlDb, userId);
    } catch (err) {
      app.log.warn({ err }, 'Failed to cancel Stripe subscriptions during account deletion');
    }

    // 5. Delete the user — ON DELETE CASCADE handles apps, api_keys, subscriptions, etc.
    await app.controlDb.query('DELETE FROM platform_users WHERE id = $1', [userId]);

    // Plan 08: personal-org row's owner_id has no FK cascade, so clean it up
    // explicitly (personal orgs are the only orgs that reach this point given
    // the guard above).
    await app.controlDb.query(
      `DELETE FROM organizations WHERE owner_id = $1 AND personal = true`,
      [userId],
    );

    return reply.send({ deleted: true });
    } catch (error) {
      if (isHttpError(error)) throw error;
      const pg = error as { code?: string; constraint?: string; table?: string; detail?: string };
      app.log.error(
        { err: error, userId, pgCode: pg.code, pgConstraint: pg.constraint, pgTable: pg.table, pgDetail: pg.detail },
        'Account deletion failed'
      );
      return reply.code(500).send(apiError(error, 'Account deletion failed'));
    }
  });

  // Stripe webhook handler — registered in its own scope so we can override
  // the content-type parser to preserve the raw body for signature verification.
  app.register(async function stripeWebhookScope(scope) {
    scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
      done(null, body);
    });

    scope.post('/webhooks/stripe', {
      config: { public: true, skipQuota: true },
    }, async (request, reply) => {
      const signature = request.headers['stripe-signature'];

      if (!signature || typeof signature !== 'string') {
        return reply.code(400).send({ error: 'Missing stripe-signature header' });
      }

      const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
      if (!webhookSecret) {
        app.log.error('STRIPE_WEBHOOK_SECRET not configured');
        return reply.code(500).send({ error: 'Webhook secret not configured' });
      }

      try {
        // Verify webhook signature
        const event = verifyWebhookSignature(
          request.body as Buffer,
          signature,
          webhookSecret
        );

        // Handle the event
        await handleWebhook(app.controlDb, event);

        return { received: true };
      } catch (error) {
        if (isHttpError(error)) throw error;
        app.log.error({ err: error, bodyType: typeof request.body, bodyLength: Buffer.isBuffer(request.body) ? request.body.length : undefined }, 'Stripe webhook processing failed');
        return reply.code(400).send({ error: 'Webhook processing failed' });
      }
    });
  });
}
