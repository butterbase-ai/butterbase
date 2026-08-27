/**
 * Provenance of a settled `provider_cost_usd`.
 *
 * Lives in its own module rather than in usage-log.ts because callers that
 * classify a cost are not always callers that write a usage row, and because
 * usage-log.ts is `vi.mock`ed wholesale in the router tests — a pure function
 * parked there would vanish behind the mock.
 */
/**
 * Where a row's `provider_cost_usd` came from. Mirrors migration 049.
 *
 *   upstream          the provider reported the real cost for this call
 *   catalog           estimated from the chosen router's own published rates
 *   catalog_inherited  estimated from rates copied off a priced sibling, because
 *                     this upstream publishes no rate card of its own
 *   catalog_unpriced  estimated against a route with no price at all, so the
 *                     charge came out $0 — always a bug, never a free call
 */
export type CostSource = 'upstream' | 'catalog' | 'catalog_inherited' | 'catalog_unpriced';

/**
 * Classify a settled cost. `route` is the catalog row actually billed against —
 * pass the same one handed to estimateWorstCaseUsd, or the ranked head.
 */
export function classifyCostSource(
  providerReportedCost: number | null | undefined,
  route: { promptPricePerMtok: number; completionPricePerMtok: number; priceInheritedFrom?: unknown } | undefined,
): CostSource {
  if (providerReportedCost !== null && providerReportedCost !== undefined) return 'upstream';
  if (!route) return 'catalog_unpriced';
  if (route.promptPricePerMtok <= 0 && route.completionPricePerMtok <= 0) return 'catalog_unpriced';
  return route.priceInheritedFrom ? 'catalog_inherited' : 'catalog';
}
