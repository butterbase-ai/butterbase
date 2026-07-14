import type { RouterName } from './normalize.js';
import type { Modality } from './adapters/types.js';

export interface CatalogRouter {
  name: RouterName;
  upstreamId: string;
  promptPricePerMtok: number;
  completionPricePerMtok: number;
  contextLength: number;
  // Defaults to 'chat' for entries written before this field existed.
  modality?: Modality;
  // Router-native pricing for non-chat modalities. See UpstreamModel.rawPricing.
  rawPricing?: unknown;
}

export interface CatalogEntry {
  canonicalId: string;
  displayName: string;
  updatedAt: string;
  routers: CatalogRouter[];
}

const SCORE_COMPLETION_WEIGHT = 3;

function score(r: CatalogRouter): number {
  return r.promptPricePerMtok * 1 + r.completionPricePerMtok * SCORE_COMPLETION_WEIGHT;
}

/**
 * Per-canonical-id router preference. When the named router is enabled AND
 * present on the entry's router list, it wins the head position over the
 * normal price-based ranking; the rest of the chain follows in the usual
 * order. Used to pin specific models to a preferred upstream for quality /
 * latency / cost reasons not captured by per-Mtok pricing alone — e.g. video
 * models where the catalog's prompt/completion columns are $0 and the real
 * pricing lives in `rawPricing` per-second variants.
 *
 * Soft hint: if the preferred router is disabled or not on the entry, the
 * ranker silently falls back to price ordering. An operator can flip the
 * router off in admin without code changes.
 */
const PREFERRED_ROUTER_BY_MODEL: Readonly<Record<string, RouterName>> = {
  'bytedance/seedance-2.0': 'provider-tertiary',
  'bytedance/seedance-2.0-fast': 'provider-tertiary',
};

/**
 * Image routing: canonical → router that owns the model. Consulted by
 * `routeImageSubmit` (router.ts) before it walks the ranker chain — the mapped
 * router is preferred when it advertises `submitImage` and `getSupportedImageParams`
 * returns non-null. Falls through to "first enabled adapter that implements
 * submitImage AND returns non-null from getSupportedImageParams(canonicalId)"
 * when the map has no entry.
 *
 * ImaRouter (provider-secondary) covers the 13 async-generation models it owns;
 * OpenRouter covers the sync-inline set from its /v1/models?output_modalities=image
 * enumeration (see adapters/openrouter.ts:OPENROUTER_IMAGE_MODELS).
 */
export const CANONICAL_IMAGE_MODEL_ROUTES: Readonly<Record<string, RouterName>> = {
  'openai/gpt-image-2':                    'provider-secondary',
  'openai/gpt-image-1':                    'openrouter',
  'openai/gpt-image-1-mini':               'openrouter',
  'google/gemini-3-pro-image-preview':     'provider-secondary',
  'google/gemini-3.1-flash-image-preview': 'provider-secondary',
  'google/gemini-2.5-flash-image':         'provider-secondary',
  'google/gemini-3.1-flash-lite-image':    'openrouter',
  'google/gemini-3.1-flash-image':         'openrouter',
  'google/gemini-3-pro-image':             'openrouter',
  // sourceful/riverflow-v2.5-pro removed: requires `aspect_ratio` (not `size`)
  // on /api/v1/images/generations and returns 422 for OpenAI-Images-shape requests.
  // Re-enable once we add per-model param mapping (size → aspect_ratio) at the adapter.
  'bytedance/seedream-5-pro':              'provider-secondary',
  'bytedance/seedream-5-lite':             'provider-secondary',
  'bytedance/seedream-4-5':                'provider-secondary',
  'alibaba/wan-2.7-image':                 'provider-secondary',
  'alibaba/wan-2.7-image-pro':             'provider-secondary',
  'alibaba/wan-2.6-t2i':                   'provider-secondary',
  'alibaba/wan-2.6-image':                 'provider-secondary',
  'prunaai/p-image':                       'provider-secondary',
  'prunaai/p-image-edit':                  'provider-secondary',
};

/**
 * Move the model's preferred router (if any) to the head of `chain`, leaving
 * the relative order of the rest unchanged. No-op when there's no override,
 * the override isn't in the chain, or it's already at the head.
 */
function promotePreferred(canonicalId: string, chain: CatalogRouter[]): CatalogRouter[] {
  const preferred = PREFERRED_ROUTER_BY_MODEL[canonicalId];
  if (!preferred) return chain;
  const idx = chain.findIndex(r => r.name === preferred);
  if (idx <= 0) return chain;
  const head = chain[idx];
  return [head, ...chain.slice(0, idx), ...chain.slice(idx + 1)];
}

/**
 * Rank routers for a model entry by weighted score (prompt*1 + completion*3),
 * ascending. Disabled routers are excluded. Ties break by router name alphabetical
 * for determinism. A `PREFERRED_ROUTER_BY_MODEL` entry, when applicable, is
 * promoted to the head after sorting.
 */
export function rankRoutersForModel(
  entry: CatalogEntry,
  enabled: Set<string>
): CatalogRouter[] {
  const ranked = entry.routers
    .filter(r => enabled.has(r.name))
    .sort((a, b) => {
      const sa = score(a);
      const sb = score(b);
      if (sa !== sb) return sa - sb;
      return a.name.localeCompare(b.name);
    });
  return promotePreferred(entry.canonicalId, ranked);
}

/**
 * Anthropic prices an ephemeral 5-minute prompt-cache *write* at 1.25× the base
 * input rate. (1-hour writes are 2×, but adapters collapse both 5m and 1h cache
 * creation into a single `cache_creation_input_tokens` count, so we apply the
 * 5m multiplier as a floor — a conservative under-estimate for 1h writes.)
 */
const CACHE_WRITE_PRICE_MULTIPLIER = 1.25;

/**
 * Worst-case USD cost: prompt_tokens × prompt_price + max_tokens × completion_price.
 * Used for lease reservation; actual cost from router response settles the lease.
 *
 * Cache-aware on the settlement-fallback path (when the upstream's `usage.cost`
 * is null), where adapters report a token breakdown:
 *
 *  - `cacheReadInputTokens`: that portion of `promptTokens` is excluded from the
 *    input-cost charge (billed at $0). We don't know each router's exact
 *    cache-read price, so this is a deliberate, customer-favorable under-estimate
 *    relative to the upstream's real cache-read line item (~0.1× input).
 *  - `cacheCreationInputTokens`: charged at `CACHE_WRITE_PRICE_MULTIPLIER × prompt
 *    price`. Unlike cache reads, cache-creation tokens are NOT part of
 *    `promptTokens` (adapters report them as a separate count), so they are
 *    *added*, not subtracted. Omitting this term silently undercharged every
 *    prompt-cache write — the expensive side of caching — by the full creation
 *    cost (see known-bugs/2026-06-23-cache-creation-tokens-unpriced.md).
 *
 * The lease-reservation call site passes no cache fields (cache state is unknown
 * before the call), preserving worst-case behavior there.
 *
 * If `cacheReadInputTokens` exceeds `promptTokens` (degenerate input), the
 * non-cached portion clamps to 0 rather than going negative.
 */
export function estimateWorstCaseUsd(
  prices: { promptPricePerMtok: number; completionPricePerMtok: number },
  promptTokens: number,
  maxCompletionTokens: number,
  cacheReadInputTokens: number = 0,
  cacheCreationInputTokens: number = 0,
): number {
  const nonCachedPromptTokens = Math.max(0, promptTokens - cacheReadInputTokens);
  const promptCost = (nonCachedPromptTokens / 1_000_000) * prices.promptPricePerMtok;
  const cacheCreationCost =
    (Math.max(0, cacheCreationInputTokens) / 1_000_000) * prices.promptPricePerMtok * CACHE_WRITE_PRICE_MULTIPLIER;
  const completionCost = (maxCompletionTokens / 1_000_000) * prices.completionPricePerMtok;
  return promptCost + cacheCreationCost + completionCost;
}

/**
 * Temporary ranker used while AI Provider Primary and AI Provider Secondary lack accurate pricing
 * in the catalog. Ignores price; picks by router presence with a randomized
 * tiebreak between AI Provider Primary and AI Provider Secondary. OpenRouter is always last when
 * present. Toggle via `AI_ROUTER_PRESENCE_MODE=true`.
 *
 * `random` is injectable for deterministic tests; defaults to Math.random.
 */
/**
 * If `pinned` is in the eligible candidate set, return it — caller should use
 * it as the head of the routing chain. Else return null and fall through to
 * normal ranking. Used by the chat path's sticky-binding integration.
 */
export function pickStickyRouter(
  candidates: RouterName[],
  pinned: RouterName | null,
): RouterName | null {
  if (pinned && candidates.includes(pinned)) return pinned;
  return null;
}

export function rankRoutersPresenceMode(
  entry: CatalogEntry,
  enabled: Set<string>,
  random: () => number = Math.random,
): CatalogRouter[] {
  const available = entry.routers.filter(r => enabled.has(r.name));
  const er = available.find(r => r.name === 'provider-primary');
  const ir = available.find(r => r.name === 'provider-secondary');
  const tr = available.find(r => r.name === 'provider-tertiary');
  const or = available.find(r => r.name === 'openrouter');

  const head: CatalogRouter[] = [];
  if (er && ir) {
    head.push(...(random() < 0.5 ? [er, ir] : [ir, er]));
  } else if (er) {
    head.push(er);
  } else if (ir) {
    head.push(ir);
  }
  // provider-tertiary trails the primary/secondary pair but precedes openrouter.
  // The PREFERRED_ROUTER_BY_MODEL hook can still promote it to the head when
  // applicable; this default keeps it routable for non-preferred models too.
  if (tr) head.push(tr);
  if (or) head.push(or);
  return promotePreferred(entry.canonicalId, head);
}

/**
 * Waterfall ranker: try slots in a fixed slot-identity order, independent of
 * which provider brand currently occupies each slot. Secondary first (highest
 * margin), then primary (reliability anchor), then any other enabled candidate
 * the catalog offers (e.g. the OSS `openrouter` adapter, provider-tertiary
 * when populated, or a future named slot) in catalog order.
 *
 * When `AI_ROUTER_MODE=waterfall` is set the router uses this ranker instead
 * of presence-mode. Combined with slot-cooldown (see slot-cooldown.ts), a slot
 * that fails with a fallback-kind error is skipped for a TTL window so we
 * don't keep re-attempting a known-degraded provider on every fresh request.
 *
 * Model-support filtering still happens upstream (via `entry.routers`), so
 * this ranker never returns a slot that doesn't list the requested model.
 */
const WATERFALL_SLOT_ORDER: readonly string[] = [
  'provider-secondary',
  'provider-primary',
];

export function rankRoutersWaterfall(
  entry: CatalogEntry,
  enabled: Set<string>,
): CatalogRouter[] {
  const available = entry.routers.filter(r => enabled.has(r.name));
  const bySlot = new Map(available.map(r => [r.name, r]));
  const ordered: CatalogRouter[] = [];
  for (const slot of WATERFALL_SLOT_ORDER) {
    const r = bySlot.get(slot as CatalogRouter['name']);
    if (r) ordered.push(r);
  }
  // Trailing tail: any enabled router not in the named slot order (OSS
  // `openrouter`, future per-tenant slots) keeps catalog order at the end.
  // Never inserted ahead of a named slot.
  for (const r of available) {
    if (!WATERFALL_SLOT_ORDER.includes(r.name) && !ordered.includes(r)) {
      ordered.push(r);
    }
  }
  return promotePreferred(entry.canonicalId, ordered);
}
