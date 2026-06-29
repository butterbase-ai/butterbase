import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getEnrichLayerPricing } from './pricing.js';

describe('getEnrichLayerPricing', () => {
  let saved: NodeJS.ProcessEnv;
  beforeEach(() => { saved = { ...process.env }; });
  afterEach(() => { process.env = saved; });

  it('defaults: base 0.0168, markup 20% → effective 0.02016', () => {
    delete process.env.ENRICHLAYER_BASE_USD_PER_CREDIT;
    delete process.env.ENRICHLAYER_MARKUP_PCT;
    const p = getEnrichLayerPricing();
    expect(p.baseUsdPerCredit).toBe(0.0168);
    expect(p.markupPct).toBe(20);
    expect(p.usdPerCredit).toBeCloseTo(0.02016, 6);
  });

  it('honors env overrides', () => {
    process.env.ENRICHLAYER_BASE_USD_PER_CREDIT = '0.02';
    process.env.ENRICHLAYER_MARKUP_PCT = '50';
    const p = getEnrichLayerPricing();
    expect(p.usdPerCredit).toBeCloseTo(0.03, 6);
  });

  it('clamps markup to [0, 200]', () => {
    process.env.ENRICHLAYER_MARKUP_PCT = '500';
    expect(getEnrichLayerPricing().markupPct).toBe(200);
    process.env.ENRICHLAYER_MARKUP_PCT = '-10';
    expect(getEnrichLayerPricing().markupPct).toBe(0);
  });
});
