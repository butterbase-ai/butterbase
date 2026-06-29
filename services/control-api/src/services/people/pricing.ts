export interface PeoplePricing {
  baseUsdPerCredit: number;
  markupPct: number;
  usdPerCredit: number;
}

export function getPeoplePricing(): PeoplePricing {
  const base = parseFloat(process.env.PEOPLE_BASE_USD_PER_CREDIT ?? '0.0168');
  const rawMarkup = parseFloat(process.env.PEOPLE_MARKUP_PCT ?? '20');
  const markup = Math.max(0, Math.min(200, Number.isFinite(rawMarkup) ? rawMarkup : 20));
  const safeBase = Number.isFinite(base) && base >= 0 ? base : 0.0168;
  return {
    baseUsdPerCredit: safeBase,
    markupPct: markup,
    usdPerCredit: safeBase * (1 + markup / 100),
  };
}
