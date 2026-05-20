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
 * Rank routers for a model entry by weighted score (prompt*1 + completion*3),
 * ascending. Disabled routers are excluded. Ties break by router name alphabetical
 * for determinism.
 */
export function rankRoutersForModel(
  entry: CatalogEntry,
  enabled: Set<string>
): CatalogRouter[] {
  return entry.routers
    .filter(r => enabled.has(r.name))
    .sort((a, b) => {
      const sa = score(a);
      const sb = score(b);
      if (sa !== sb) return sa - sb;
      return a.name.localeCompare(b.name);
    });
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
  const or = available.find(r => r.name === 'openrouter');

  const head: CatalogRouter[] = [];
  if (er && ir) {
    head.push(...(random() < 0.5 ? [er, ir] : [ir, er]));
  } else if (er) {
    head.push(er);
  } else if (ir) {
    head.push(ir);
  }
  if (or) head.push(or);
  return head;
}
