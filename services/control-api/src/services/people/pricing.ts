import { config } from '../../config.js';
import type { ProviderSlot } from './types.js';

export interface PeoplePricing {
  baseUsdPerCredit: number;
  markupPct: number;
  usdPerCredit: number;
}

export function getPeoplePricing(slot: ProviderSlot = 'primary'): PeoplePricing {
  const providerCfg = config.people.providers[slot];
  const base = providerCfg?.baseUsdPerCredit ?? 0.0168;
  const rawMarkup = providerCfg?.markupPct ?? 20;
  const safeBase = Number.isFinite(base) && base >= 0 ? base : 0.0168;
  const safeMarkup = Math.max(0, Math.min(200, Number.isFinite(rawMarkup) ? rawMarkup : 20));
  return {
    baseUsdPerCredit: safeBase,
    markupPct: safeMarkup,
    usdPerCredit: safeBase * (1 + safeMarkup / 100),
  };
}
