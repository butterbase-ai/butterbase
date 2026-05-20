import { describe, it, expect } from 'vitest';
import { UnlimitedQuotaEnforcer, type QuotaEnforcer } from './index.js';

describe('UnlimitedQuotaEnforcer', () => {
  const enforcer: QuotaEnforcer = new UnlimitedQuotaEnforcer();

  it('always grants a lease', async () => {
    const lease = await enforcer.acquireLease('user-123', { kind: 'ai_credits' });
    expect(lease.granted).toBe(true);
    expect(lease.leaseId).toBeTruthy();
  });

  it('settle is a no-op', async () => {
    await expect(
      enforcer.settleLease('lease-abc', { actualUsdSpent: 0.5 })
    ).resolves.toBeUndefined();
  });

  it('getRemaining returns Infinity', async () => {
    const remaining = await enforcer.getRemaining('user-123', 'ai_credits');
    expect(remaining).toBe(Infinity);
  });
});
