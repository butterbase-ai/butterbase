import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getPeoplePricing } from './pricing.js';

describe('getPeoplePricing', () => {
  let saved: NodeJS.ProcessEnv;
  beforeEach(() => { saved = { ...process.env }; });
  afterEach(() => { process.env = saved; });

  it('defaults: base 0.0168, markup 20% → effective 0.02016', () => {
    delete process.env.PEOPLE_BASE_USD_PER_CREDIT;
    delete process.env.PEOPLE_MARKUP_PCT;
    const p = getPeoplePricing();
    expect(p.baseUsdPerCredit).toBe(0.0168);
    expect(p.markupPct).toBe(20);
    expect(p.usdPerCredit).toBeCloseTo(0.02016, 6);
  });

  it('honors env overrides', () => {
    process.env.PEOPLE_BASE_USD_PER_CREDIT = '0.02';
    process.env.PEOPLE_MARKUP_PCT = '50';
    const p = getPeoplePricing();
    expect(p.usdPerCredit).toBeCloseTo(0.03, 6);
  });

  it('clamps markup to [0, 200]', () => {
    process.env.PEOPLE_MARKUP_PCT = '500';
    expect(getPeoplePricing().markupPct).toBe(200);
    process.env.PEOPLE_MARKUP_PCT = '-10';
    expect(getPeoplePricing().markupPct).toBe(0);
  });
});
