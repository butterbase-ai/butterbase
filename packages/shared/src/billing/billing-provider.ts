export type PlanTier = 'free' | 'pro' | 'enterprise';

export interface Plan {
  tier: PlanTier;
  features: string[];
}

export interface Subscription {
  id: string;
  userId: string;
  planTier: PlanTier;
  status: 'active' | 'past_due' | 'canceled';
  currentPeriodEnd: Date;
}

export interface UsageEvent {
  kind: 'ai_credits' | 'function_invocations' | 'storage_gb_hours' | 'bandwidth_gb';
  amountUsd: number;
  metadata?: Record<string, unknown>;
}

export interface BillingProvider {
  getActiveSubscription(userId: string): Promise<Subscription | null>;
  getPlanForUser(userId: string): Promise<Plan>;
  recordUsage(userId: string, event: UsageEvent): Promise<void>;
  isFeatureEnabled(userId: string, feature: string): Promise<boolean>;
}

export class NoopBillingProvider implements BillingProvider {
  async getActiveSubscription(_userId: string): Promise<Subscription | null> {
    return null;
  }
  async getPlanForUser(_userId: string): Promise<Plan> {
    return { tier: 'free', features: [] };
  }
  async recordUsage(_userId: string, _event: UsageEvent): Promise<void> {
    // self-hosters who don't wire a billing provider get no metering
  }
  async isFeatureEnabled(_userId: string, _feature: string): Promise<boolean> {
    return false;
  }
}
