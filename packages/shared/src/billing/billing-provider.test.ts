import { describe, it, expect } from 'vitest';
import { NoopBillingProvider, type BillingProvider } from './index.js';

describe('NoopBillingProvider', () => {
  const provider: BillingProvider = new NoopBillingProvider();

  it('reports no active subscription for any user', async () => {
    const sub = await provider.getActiveSubscription('user-123');
    expect(sub).toBeNull();
  });

  it('returns "free" plan for any user', async () => {
    const plan = await provider.getPlanForUser('user-123');
    expect(plan).toEqual({ tier: 'free', features: [] });
  });

  it('recordUsage is a no-op (returns void, does not throw)', async () => {
    await expect(
      provider.recordUsage('user-123', { kind: 'ai_credits', amountUsd: 0.05 })
    ).resolves.toBeUndefined();
  });

  it('isFeatureEnabled returns false for any feature', async () => {
    expect(await provider.isFeatureEnabled('user-123', 'enterprise')).toBe(false);
  });
});
