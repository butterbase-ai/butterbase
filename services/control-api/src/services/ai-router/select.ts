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
 * Worst-case USD cost: prompt_tokens × prompt_price + max_tokens × completion_price.
 * Used for lease reservation; actual cost from router response settles the lease.
 */
export function estimateWorstCaseUsd(
  prices: { promptPricePerMtok: number; completionPricePerMtok: number },
  promptTokens: number,
  maxCompletionTokens: number
): number {
  const promptCost = (promptTokens / 1_000_000) * prices.promptPricePerMtok;
  const completionCost = (maxCompletionTokens / 1_000_000) * prices.completionPricePerMtok;
  return promptCost + completionCost;
}

/**
 * Temporary ranker used while AI Provider Primary and AI Provider Secondary lack accurate pricing
 * in the catalog. Ignores price; picks by router presence with a randomized
 * tiebreak between AI Provider Primary and AI Provider Secondary. OpenRouter is always last when
 * present. Toggle via `AI_ROUTER_PRESENCE_MODE=true`.
 *
 * `random` is injectable for deterministic tests; defaults to Math.random.
 */
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
