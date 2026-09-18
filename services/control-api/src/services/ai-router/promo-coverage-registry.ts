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
   * Decided BEFORE admission. Returns the name of the router whose calls the
   * credit pays for, or null when this model is not covered.
   *
   * A router name rather than a boolean, because funding is a property of the
   * provider, not the model: a coupon-eligible model is usually carried by
   * other routers too, and the router falls back between them. The caller is
   * only left unbilled while the funded router is actually serving.
   *
   * Must never throw: a coverage backend that is down has to fall back to
   * normal paid billing rather than failing the request.
   */
  fundedRouter(canonicalId: string): Promise<string | null>;

  /**
   * Called AFTER the call with the authoritative provider cost, only for a call
   * the funded router actually served. This is the only place promo spend is
   * recorded — there is no pre-reservation to correct.
   *
   * Must never throw, for the same reason as `fundedRouter()`.
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
 * Resolve the funded router for one call, swallowing backend failures. A promo
 * that cannot be reached is treated as "not covered" — the user is charged as
 * normal, which is recoverable, rather than given away free against a budget we
 * cannot read.
 */
export async function promoFundedRouter(canonicalId: string): Promise<string | null> {
  const coverage = registered;
  if (!coverage) return null;
  try {
    return await coverage.fundedRouter(canonicalId);
  } catch (err) {
    console.warn('[promo-coverage] fundedRouter() failed, billing normally:', err);
    return null;
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
