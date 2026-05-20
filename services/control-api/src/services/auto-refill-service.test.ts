import { describe, it, expect, vi } from 'vitest';

// Mock modules that throw at load time due to missing env vars.
vi.mock('./stripe-service.js', () => ({
  purchaseAutoRefillCredits: vi.fn(),
}));
vi.mock('./auth/email-service.js', () => ({
  sendBillingEmail: vi.fn(),
}));

import { maybeTriggerAutoRefill } from './auto-refill-service.js';

describe('maybeTriggerAutoRefill — gating', () => {
  function makeDeps(overrides: Partial<any> = {}) {
    return {
      pool: {
        query: vi.fn(async () => ({ rows: [] })),
      },
      redis: {
        set: vi.fn(async () => 'OK'),
        del: vi.fn(async () => 1),
      },
      stripeCharge: vi.fn(),
      grantAutoRefill: vi.fn(),
      flipDisabled: vi.fn(),
      sendEmail: vi.fn(),
      ...overrides,
    };
  }

  it('no-op when credits_usd >= 5 (and monthly is empty)', async () => {
    const deps = makeDeps({
      pool: { query: vi.fn(async () => ({ rows: [{
        monthly_allowance_usd: '0',
        credits_usd: '10', auto_refill_enabled: true,
        auto_refill_amount_usd: '20', email: 'u@x.com',
      }] })) },
    });
    const r = await maybeTriggerAutoRefill(deps as any, 'user-1');
    expect(r.attempted).toBe(false);
    expect(r.reason).toBe('not_low');
    expect(deps.stripeCharge).not.toHaveBeenCalled();
    expect(deps.redis.set).not.toHaveBeenCalled();
  });

  it('no-op when auto_refill_enabled is false', async () => {
    const deps = makeDeps({
      pool: { query: vi.fn(async () => ({ rows: [{
        monthly_allowance_usd: '0',
        credits_usd: '1', auto_refill_enabled: false,
        auto_refill_amount_usd: '20', email: 'u@x.com',
      }] })) },
    });
    const r = await maybeTriggerAutoRefill(deps as any, 'user-1');
    expect(r.attempted).toBe(false);
    expect(r.reason).toBe('disabled');
  });

  it('no-op when auto_refill_amount_usd is null or zero', async () => {
    const deps = makeDeps({
      pool: { query: vi.fn(async () => ({ rows: [{
        monthly_allowance_usd: '0',
        credits_usd: '1', auto_refill_enabled: true,
        auto_refill_amount_usd: null, email: 'u@x.com',
      }] })) },
    });
    const r = await maybeTriggerAutoRefill(deps as any, 'user-1');
    expect(r.attempted).toBe(false);
    expect(r.reason).toBe('disabled');
  });

  it('no-op when Redis lock is already held', async () => {
    const deps = makeDeps({
      pool: { query: vi.fn(async () => ({ rows: [{
        monthly_allowance_usd: '0',
        credits_usd: '1', auto_refill_enabled: true,
        auto_refill_amount_usd: '20', email: 'u@x.com',
      }] })) },
      redis: { set: vi.fn(async () => null), del: vi.fn() },
    });
    const r = await maybeTriggerAutoRefill(deps as any, 'user-1');
    expect(r.attempted).toBe(false);
    expect(r.reason).toBe('locked');
    expect(deps.stripeCharge).not.toHaveBeenCalled();
  });

  it('happy path: charges, grants, releases lock', async () => {
    const deps = makeDeps({
      pool: { query: vi.fn(async () => ({ rows: [{
        monthly_allowance_usd: '0',
        credits_usd: '2', auto_refill_enabled: true,
        auto_refill_amount_usd: '20', email: 'u@x.com',
      }] })) },
      stripeCharge: vi.fn(async () => ({ status: 'succeeded', paymentIntentId: 'pi_123' })),
      grantAutoRefill: vi.fn(async () => ({ granted: 20 })),
    });
    const r = await maybeTriggerAutoRefill(deps as any, 'user-1');
    expect(r.attempted).toBe(true);
    expect(r.status).toBe('succeeded');
    expect(deps.stripeCharge).toHaveBeenCalledWith('user-1', 20);
    expect(deps.grantAutoRefill).toHaveBeenCalledWith('user-1', 20, 'pi_123');
    expect(deps.flipDisabled).not.toHaveBeenCalled();
    expect(deps.sendEmail).not.toHaveBeenCalled();
    expect(deps.redis.del).toHaveBeenCalled();
  });

  it('failure path: flips off + emails + does not grant', async () => {
    const deps = makeDeps({
      pool: { query: vi.fn(async () => ({ rows: [{
        monthly_allowance_usd: '0',
        credits_usd: '2', auto_refill_enabled: true,
        auto_refill_amount_usd: '20', email: 'u@x.com',
      }] })) },
      stripeCharge: vi.fn(async () => ({ status: 'failed', paymentIntentId: '', failureReason: 'card_declined' })),
    });
    const r = await maybeTriggerAutoRefill(deps as any, 'user-1');
    expect(r.attempted).toBe(true);
    expect(r.status).toBe('failed');
    expect(deps.flipDisabled).toHaveBeenCalledWith('user-1', 'card_declined');
    expect(deps.sendEmail).toHaveBeenCalledWith('u@x.com', 'auto_refill_failed', expect.objectContaining({
      amount_usd: '20.00',
      failure_reason: 'card_declined',
    }));
    expect(deps.grantAutoRefill).not.toHaveBeenCalled();
    expect(deps.redis.del).toHaveBeenCalled();
  });

  it('releases lock even when stripeCharge throws unexpectedly', async () => {
    const deps = makeDeps({
      pool: { query: vi.fn(async () => ({ rows: [{
        monthly_allowance_usd: '0',
        credits_usd: '2', auto_refill_enabled: true,
        auto_refill_amount_usd: '20', email: 'u@x.com',
      }] })) },
      stripeCharge: vi.fn(async () => { throw new Error('network'); }),
    });
    const r = await maybeTriggerAutoRefill(deps as any, 'user-1');
    expect(r.attempted).toBe(true);
    expect(r.status).toBe('failed');
    expect(deps.redis.del).toHaveBeenCalled();
  });

  it('no-op when monthly_allowance > 0 (even if topup < 5)', async () => {
    const deps = makeDeps({
      pool: { query: vi.fn(async () => ({ rows: [{
        monthly_allowance_usd: '3',
        credits_usd: '1',
        auto_refill_enabled: true,
        auto_refill_amount_usd: '20',
        email: 'u@x.com',
      }] })) },
    });
    const r = await maybeTriggerAutoRefill(deps as any, 'user-1');
    expect(r.attempted).toBe(false);
    expect(r.reason).toBe('not_low');
    expect(deps.stripeCharge).not.toHaveBeenCalled();
  });

  it('triggers when monthly == 0 AND topup < 5', async () => {
    const deps = makeDeps({
      pool: { query: vi.fn(async () => ({ rows: [{
        monthly_allowance_usd: '0',
        credits_usd: '2',
        auto_refill_enabled: true,
        auto_refill_amount_usd: '20',
        email: 'u@x.com',
      }] })) },
      stripeCharge: vi.fn(async () => ({ status: 'succeeded', paymentIntentId: 'pi_x' })),
      grantAutoRefill: vi.fn(async () => ({ granted: 20 })),
    });
    const r = await maybeTriggerAutoRefill(deps as any, 'user-1');
    expect(r.attempted).toBe(true);
    expect(r.status).toBe('succeeded');
  });
});
