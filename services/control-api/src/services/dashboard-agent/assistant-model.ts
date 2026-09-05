/**
 * ============================================================================
 * ASSISTANT MODEL — the DEFAULT the dashboard assistant runs on, not the only
 * option.
 *
 * Why this id is the default: it is in PREFERRED_ROUTER_BY_MODEL (select.ts),
 * so a default turn is served direct by the vendor slot rather than through an
 * aggregator.
 *
 * PRICE, and why this id specifically: the vendor's PUBLIC pricing page omits
 * every qwen3.8 variant, but the Model Studio console quotes qwen3.8-max at
 * $0.002/1K in and $0.006/1K out — i.e. $2.00/$6.00 per Mtok, flat, no
 * input-size tiers. That is exactly what the aggregator charges for the same
 * id, so routing it direct is cost-neutral. It matters that this is a real
 * quoted rate rather than an estimate: the direct adapter reports
 * `providerCostUsd: null` and billing settles from the catalog price, so a
 * guessed number here would bill customers a guess.
 *
 * Model choice is OPEN: `resolveAssistantModel` honours a caller-supplied id
 * and falls back to this default only when none is given. The dashboard picker
 * lists the chat models in the router catalog and persists the choice on the
 * conversation (PATCH /conversations/:id), so regenerate and resume replay on
 * the same model that served the original turn.
 *
 * CAVEAT worth knowing: the catalog carries no tool-support metadata, so the
 * picker cannot filter to models that can actually drive this agent's tool
 * loop. A model without tool-calling will connect and then fail to make
 * progress. Filtering that out is not possible until the catalog carries the
 * flag.
 * ============================================================================
 */
export const DEFAULT_ASSISTANT_MODEL = 'qwen/qwen3.8-max';

/**
 * Resolve the model for a turn. An explicit id always wins; the default fills
 * in for callers that send nothing and for conversations predating the picker.
 *
 * Blank and whitespace-only ids are treated as absent rather than forwarded.
 * The zod `.default()` on the request bodies only fires when the key is
 * missing, so `{"model": ""}` would otherwise reach the gateway verbatim and
 * come back as a `model_not_found` the user cannot act on.
 */
export function resolveAssistantModel(requested?: string | null): string {
  return requested?.trim() || DEFAULT_ASSISTANT_MODEL;
}
