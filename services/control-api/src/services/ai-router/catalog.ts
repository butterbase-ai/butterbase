import type { Redis } from 'ioredis';
import type { RouterName } from './normalize.js';
import { canonicalizeUpstreamId } from './normalize.js';
import type { CatalogEntry, CatalogRouter } from './select.js';
import type { RouterAdapter } from './adapters/types.js';

export type { CatalogEntry, CatalogRouter };

export interface RouterStatus {
  name: RouterName;
  enabled: boolean;
  lastRefreshAt: string;
  lastRefreshStatus: 'ok' | 'failed' | 'skipped';
}

const KEY_MODEL_PREFIX = 'ai_catalog:model:';
const KEY_MODELS = 'ai_catalog:models';
const KEY_ROUTERS = 'ai_catalog:routers';
const KEY_LOCK_REFRESH = 'ai_catalog:lock:refresh';
const KEY_UNKNOWN = 'ai_catalog:unknown';

export async function readCatalogEntry(redis: Redis, canonicalId: string): Promise<CatalogEntry | null> {
  const raw = await redis.get(KEY_MODEL_PREFIX + canonicalId);
  if (!raw) return null;
  try { return JSON.parse(raw) as CatalogEntry; } catch { return null; }
}

export async function listCatalogModels(redis: Redis): Promise<string[]> {
  const raw = await redis.get(KEY_MODELS);
  if (!raw) return [];
  try { return JSON.parse(raw) as string[]; } catch { return []; }
}

export async function readEnabledRouters(redis: Redis): Promise<RouterStatus[]> {
  const raw = await redis.get(KEY_ROUTERS);
  if (!raw) return [];
  try { return JSON.parse(raw) as RouterStatus[]; } catch { return []; }
}

/**
 * Atomically replace the entire catalog. Entries that disappear from the new
 * payload are DEL'd in the same pipeline. The visible state never holds a
 * half-flipped catalog.
 */
export async function writeCatalog(
  redis: Redis,
  entries: CatalogEntry[],
  routers: RouterStatus[]
): Promise<void> {
  const newIds = new Set(entries.map(e => e.canonicalId));
  const existingIds = await listCatalogModels(redis);
  const toDelete = existingIds.filter(id => !newIds.has(id));

  const pipeline = redis.multi();
  for (const id of toDelete) pipeline.del(KEY_MODEL_PREFIX + id);
  for (const e of entries) pipeline.set(KEY_MODEL_PREFIX + e.canonicalId, JSON.stringify(e));
  pipeline.set(KEY_MODELS, JSON.stringify(Array.from(newIds).sort()));
  pipeline.set(KEY_ROUTERS, JSON.stringify(routers));
  await pipeline.exec();
}

/**
 * Acquire the refresher cron lock. TTL in seconds. Returns true if acquired,
 * false if another instance already holds it.
 */
export async function tryAcquireRefreshLock(redis: Redis, ttlSec: number): Promise<boolean> {
  const result = await redis.set(KEY_LOCK_REFRESH, '1', 'EX', ttlSec, 'NX');
  return result === 'OK';
}

export async function releaseRefreshLock(redis: Redis): Promise<void> {
  await redis.del(KEY_LOCK_REFRESH);
}

/**
 * Record an upstream id that couldn't be normalized. Capped at ~1000 entries.
 * Ops reviews and adds overrides to normalize-overrides.json.
 */
export async function recordUnknownId(redis: Redis, router: RouterName, upstreamId: string): Promise<void> {
  await redis.sadd(KEY_UNKNOWN, `${router}:${upstreamId}`);
  const card = await redis.scard(KEY_UNKNOWN);
  if (card > 1000) await redis.spop(KEY_UNKNOWN, card - 1000);
}

export interface CatalogMeta {
  lastRefreshedAt: string | null;
  modelCount: number;
}

/**
 * Read freshness metadata for the catalog. lastRefreshedAt is derived from
 * the most-recent router status entry (the writer sets lastRefreshAt on every
 * refresh, success or skipped); modelCount comes from the canonical model list.
 */
export async function getCatalogMeta(redis: Redis): Promise<CatalogMeta> {
  const [models, routers] = await Promise.all([
    listCatalogModels(redis),
    readEnabledRouters(redis),
  ]);
  let lastRefreshedAt: string | null = null;
  for (const r of routers) {
    if (!r.lastRefreshAt) continue;
    if (lastRefreshedAt === null || r.lastRefreshAt > lastRefreshedAt) {
      lastRefreshedAt = r.lastRefreshAt;
    }
  }
  return { lastRefreshedAt, modelCount: models.length };
}

export interface RefreshResult {
  modelCount: number;
  lastRefreshedAt: string;
  routers: RouterStatus[];
}

/**
 * Drive a catalog refresh from a set of router adapters. Each adapter's
 * listModels() is invoked; upstream ids are canonicalized via
 * canonicalizeUpstreamId and grouped into CatalogEntry rows. Results are
 * persisted atomically via writeCatalog. Unknown ids (no canonical mapping)
 * are recorded for ops triage.
 *
 * Caller is responsible for lock acquisition (tryAcquireRefreshLock) when
 * coordinating with the cron refresher.
 */
/**
 * Fill in per-Mtok prices for chat routes whose upstream publishes none.
 *
 * Some routers settle from an authoritative post-call cost (OpenRouter's
 * `usage.cost`, provider-secondary's and provider-tertiary's billing ledgers)
 * and therefore have no reason to publish a rate card. Their catalog rows
 * legitimately carry 0/0. That is fine right up until the cost lookup fails —
 * `router.ts` then falls back to `estimateWorstCaseUsd`, which multiplies by
 * those zeros and settles the call at $0. The customer is billed nothing and
 * we still pay the upstream, with nothing logged.
 *
 * So an unpriced chat route borrows a priced sibling's rates as a
 * last-resort estimate. It is never the billing basis when the real cost is
 * available — only the floor under a failed lookup.
 *
 * Donor preference:
 *   1. `openrouter`, when it offers the same model. It is the closest thing to
 *      a public reference rate for a canonical id.
 *   2. otherwise the CHEAPEST priced sibling, by the same prompt + 3x
 *      completion weighting the ranker uses. Cheapest rather than dearest so a
 *      failed lookup cannot silently overcharge; it can only under-recover,
 *      which is the direction we already tolerate.
 *
 * Non-chat rows are left strictly alone. Video rows carry 0/0 by design and
 * price per second via `rawPricing`; copying token rates onto them would
 * invent a charge that does not exist. Rows carrying `rawPricing` are skipped
 * for the same reason.
 */
export function inheritMissingChatPrices(routers: CatalogRouter[]): CatalogRouter[] {
  const isChat = (r: CatalogRouter) => (r.modality ?? 'chat') === 'chat' && r.rawPricing === undefined;
  const isPriced = (r: CatalogRouter) => r.promptPricePerMtok > 0 || r.completionPricePerMtok > 0;
  const weight = (r: CatalogRouter) => r.promptPricePerMtok + 3 * r.completionPricePerMtok;

  const donors = routers.filter(r => isChat(r) && isPriced(r));
  if (donors.length === 0) return routers;

  const donor =
    donors.find(d => d.name === 'openrouter')
    ?? [...donors].sort((a, b) => weight(a) - weight(b) || a.name.localeCompare(b.name))[0];

  return routers.map(r => {
    if (!isChat(r) || isPriced(r) || r.name === donor.name) return r;
    return {
      ...r,
      promptPricePerMtok: donor.promptPricePerMtok,
      completionPricePerMtok: donor.completionPricePerMtok,
      priceInheritedFrom: donor.name,
    };
  });
}

export async function refreshCatalog(
  redis: Redis,
  adapters: RouterAdapter[],
): Promise<RefreshResult> {
  const now = new Date().toISOString();
  const byCanonical = new Map<string, { displayName: string; routers: CatalogRouter[] }>();
  const statuses: RouterStatus[] = [];

  for (const adapter of adapters) {
    try {
      const models = await adapter.listModels();
      for (const m of models) {
        const canonical = canonicalizeUpstreamId(adapter.name, m.upstreamId);
        if (!canonical) {
          await recordUnknownId(redis, adapter.name, m.upstreamId);
          continue;
        }
        const entry = byCanonical.get(canonical) ?? { displayName: m.displayName, routers: [] };
        entry.routers.push({
          name: adapter.name,
          upstreamId: m.upstreamId,
          promptPricePerMtok: m.promptPricePerMtok,
          completionPricePerMtok: m.completionPricePerMtok,
          contextLength: m.contextLength,
          modality: m.modality,
          rawPricing: m.rawPricing,
        });
        if (!entry.displayName) entry.displayName = m.displayName;
        byCanonical.set(canonical, entry);
      }
      statuses.push({ name: adapter.name, enabled: true, lastRefreshAt: now, lastRefreshStatus: 'ok' });
    } catch (err) {
      console.warn(`[ai-catalog] refresh failed for ${adapter.name}:`, err);
      statuses.push({ name: adapter.name, enabled: true, lastRefreshAt: now, lastRefreshStatus: 'failed' });
    }
  }

  const entries: CatalogEntry[] = Array.from(byCanonical.entries()).map(([canonicalId, v]) => ({
    canonicalId,
    displayName: v.displayName,
    updatedAt: now,
    routers: inheritMissingChatPrices(v.routers),
  }));

  await writeCatalog(redis, entries, statuses);
  return { modelCount: entries.length, lastRefreshedAt: now, routers: statuses };
}
