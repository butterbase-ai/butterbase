import { describe, it, expect } from 'vitest';
import { InsufficientCreditsError, MIN_LEASE_USD } from './billing-gate.js';

describe('InsufficientCreditsError — floor shape', () => {
  it('carries balance and floor', () => {
    const e = new InsufficientCreditsError({ balanceUsd: -30, floorUsd: -25 });
    expect(e.balanceUsd).toBe(-30);
    expect(e.floorUsd).toBe(-25);
    expect(e.message).toContain('-30');
    expect(e.message).toContain('-25');
  });
});

describe('MIN_LEASE_USD', () => {
  it('is the smallest value satisfying amount_usd > 0 at NUMERIC(12,4)', () => {
    expect(MIN_LEASE_USD).toBe(0.0001);
  });
});
