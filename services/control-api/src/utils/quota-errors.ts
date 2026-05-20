// Standardized quota/limit error responses with upgrade URL
import { config } from '../config.js';

const upgradeUrl = `${config.dashboardUrl}/billing`;

export const quotaErrors = {
  aiCreditsExhausted(current: number, limit: number) {
    return {
      error: 'ai_credits_exhausted',
      meter: 'ai_credits',
      current,
      limit,
      modal: 'upgrade',
      message: `You've used your $${limit.toFixed(2)} AI credit allowance. Upgrade to Launch ($19/mo) to get $5/mo in AI credits with pay-as-you-go overage.`,
      upgradeUrl,
    };
  },

  spendingCapReached(currentSpend: number, cap: number, overageRate: number | null) {
    return {
      error: 'spending_cap_reached',
      modal: 'cap_reached',
      currentSpend,
      cap,
      overageRate,
      message: `You've hit your $${cap.toFixed(0)}/mo AI spending cap. Raise your cap or buy a credit pack to continue.`,
      upgradeUrl,
      actions: {
        raiseCap: `${config.dashboardUrl}/billing/spending-cap`,
        buyTopup: `${config.dashboardUrl}/billing/topup`,
      },
    };
  },

  planLimitExceeded(meter: string, current: number, limit: number) {
    return {
      error: 'plan_limit_exceeded',
      meter,
      current,
      limit,
      message: `You have exceeded your ${meter.replace(/_/g, ' ')} limit. Upgrade your plan to continue.`,
      upgradeUrl,
    };
  },

  projectLimitReached(current: number, limit: number) {
    return {
      error: 'project_limit_reached',
      current,
      limit,
      message: `Your plan allows ${limit} project${limit === 1 ? '' : 's'}. Upgrade to create more.`,
      upgradeUrl,
    };
  },

  accountSoftLocked() {
    return {
      error: 'account_soft_locked',
      message: 'Your account is in read-only mode due to exceeding free plan limits. Upgrade or reduce usage to restore full access.',
      upgradeUrl,
    };
  },

  accountSuspended() {
    return {
      error: 'account_suspended',
      message: 'Your account has been suspended. Please contact support.',
      upgradeUrl,
    };
  },

  featureNotAvailable(feature: string) {
    return {
      error: 'feature_not_available',
      feature,
      message: `This feature requires a Pro plan or above. Upgrade to unlock it.`,
      upgradeUrl,
    };
  },
};
