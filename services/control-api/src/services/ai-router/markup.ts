/**
 * Apply our markup to the router's provider cost, returning the credits
 * we deduct from the user. Clamped defensively to [0, 200]% to guard
 * against a typoed env var.
 */
export function applyMarkup(providerCostUsd: number, markupPct: number): number {
  if (!Number.isFinite(providerCostUsd) || providerCostUsd <= 0) return 0;
  const safePct = Math.max(0, Math.min(200, Number.isFinite(markupPct) ? markupPct : 0));
  return providerCostUsd * (1 + safePct / 100);
}
