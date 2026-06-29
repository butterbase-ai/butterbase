import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../config.js', () => ({
  config: {
    people: {
      providers: {
        primary: {
          baseUsdPerCredit: 0.0168,
          markupPct: 20,
        },
        secondary: {
          baseUsdPerCredit: 0.025,
          markupPct: 50,
        },
      },
    },
  },
}));

import { getPeoplePricing } from './pricing.js';
import { config } from '../../config.js';

describe('getPeoplePricing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset primary provider to defaults
    (config.people.providers.primary as any).baseUsdPerCredit = 0.0168;
    (config.people.providers.primary as any).markupPct = 20;
    (config.people.providers.secondary as any).baseUsdPerCredit = 0.025;
    (config.people.providers.secondary as any).markupPct = 50;
  });

  it('defaults (primary slot): base 0.0168, markup 20% → effective 0.02016', () => {
    const p = getPeoplePricing('primary');
    expect(p.baseUsdPerCredit).toBe(0.0168);
    expect(p.markupPct).toBe(20);
    expect(p.usdPerCredit).toBeCloseTo(0.02016, 6);
  });

  it('no-arg call defaults to primary slot', () => {
    const p = getPeoplePricing();
    expect(p.baseUsdPerCredit).toBe(0.0168);
    expect(p.usdPerCredit).toBeCloseTo(0.02016, 6);
  });

  it('secondary slot reads from secondary provider config', () => {
    const p = getPeoplePricing('secondary');
    expect(p.baseUsdPerCredit).toBe(0.025);
    expect(p.markupPct).toBe(50);
    expect(p.usdPerCredit).toBeCloseTo(0.025 * 1.5, 6);
  });

  it('clamps markup to [0, 200]', () => {
    (config.people.providers.primary as any).markupPct = 500;
    expect(getPeoplePricing('primary').markupPct).toBe(200);
    (config.people.providers.primary as any).markupPct = -10;
    expect(getPeoplePricing('primary').markupPct).toBe(0);
  });
});
