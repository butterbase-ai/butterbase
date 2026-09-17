/**
 * Optional hook letting a cloud overlay declare that a model's calls are paid
 * for out of a provider credit/coupon rather than the caller's credits.
 *
 * Why this lives in the router rather than a Fastify preHandler: a preHandler
 * can only guess at cost before the call and has to re-parse usage afterwards —
 * which differs per endpoint shape (`prompt_tokens` vs `input_tokens`) and is
 * unavailable entirely for streamed responses written straight to `reply.raw`.
 * The router already resolves the authoritative cost once, for every endpoint
 * shape and both streaming modes, immediately before it settles the lease.
 * Coverage decisions belong at that same point.
 *
 * OSS mode registers nothing and `getPromoCoverage()` returns null, so the
 * router keeps its existing behaviour with no branch cost.
 */
export interface PromoCoverage {
  /**
   * Decided BEFORE admission. When true the caller is not leased or charged,
   * so a zero balance must not block the call.
   *
   * Must never throw: a coverage backend that is down has to fall back to
   * normal paid billing rather than failing the request.
   */
  covers(canonicalId: string): Promise<boolean>;

  /**
   * Called AFTER the call with the authoritative provider cost, for a call
   * `covers()` approved. This is the only place promo spend is recorded — there
   * is no pre-reservation to correct.
   *
   * Must never throw, for the same reason as `covers()`.
   */
  record(canonicalId: string, providerCostUsd: number): Promise<void>;
}

let registered: PromoCoverage | null = null;

export function setPromoCoverage(coverage: PromoCoverage | null): void {
  registered = coverage;
}

export function getPromoCoverage(): PromoCoverage | null {
  return registered;
}

/**
 * Resolve coverage for one call, swallowing backend failures. A promo that
 * cannot be reached is treated as "not covered" — the user is charged as
 * normal, which is recoverable, rather than given away free against a budget
 * we cannot read.
 */
export async function isCoveredByPromo(canonicalId: string): Promise<boolean> {
  const coverage = registered;
  if (!coverage) return false;
  try {
    return await coverage.covers(canonicalId);
  } catch (err) {
    console.warn('[promo-coverage] covers() failed, billing normally:', err);
    return false;
  }
}

/** Record promo spend, swallowing failures. Never blocks or fails the call. */
export async function recordPromoSpend(canonicalId: string, providerCostUsd: number): Promise<void> {
  const coverage = registered;
  if (!coverage) return;
  try {
    await coverage.record(canonicalId, providerCostUsd);
  } catch (err) {
    console.warn('[promo-coverage] record() failed, spend not counted:', err);
  }
}
