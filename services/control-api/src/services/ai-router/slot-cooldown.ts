import type { Redis } from 'ioredis';
import type { RouterName } from './normalize.js';

/**
 * Per-slot Redis cooldown to depriorotize a provider slot for a TTL window
 * after it fails with a fallback-kind error (`insufficient_credits`,
 * `transport`, `rate_limit`, etc.).
 *
 * Motivation: the waterfall ranker always tries `provider-secondary` first
 * for the highest margin. When secondary has been out of credits for the past
 * 20 minutes, every fresh session still pays the roundtrip to imarouter,
 * eats the error, and only then falls over to primary. That's wasted latency
 * and wasted signal-to-noise in logs.
 *
 * With cooldown: on each fallback-kind failure, mark the slot `down` in Redis
 * with a short TTL (default 5 minutes). The ranker reads the down-set before
 * each request and drops any cooled-down slot from `enabled`, so waterfall
 * naturally skips it. The TTL auto-clears — no ops toil to unstick a
 * recovered provider.
 *
 * Read is best-effort: a Redis blip must NEVER break the routing decision.
 * Write is fire-and-forget for the same reason — a failed mark is a mild
 * degradation (extra retries next call), not a correctness bug.
 */

const KEY_PREFIX = 'ai_router:slot_down:';
const DEFAULT_TTL_SECONDS = 300;

function keyFor(slot: RouterName): string {
  return `${KEY_PREFIX}${slot}`;
}

export async function markSlotDown(
  redis: Redis,
  slot: RouterName,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): Promise<void> {
  try {
    await redis.set(keyFor(slot), '1', 'EX', ttlSeconds);
  } catch (e) {
    console.warn(`[ai-router] markSlotDown(${slot}) failed:`, e);
  }
}

/**
 * Read the down-set. Returns a Set of currently-cooling-down slot names.
 * Uses one MGET across the fixed slot list rather than SCAN so it's O(slots)
 * and does not need Redis KEYS semantics.
 *
 * `candidates` is the list of slots to poll — pass the union of catalog +
 * enabled slots so we don't waste an MGET slot on a name we don't recognize.
 * On any Redis error returns an empty set so the ranker sees nothing cooled
 * down and behaves as before (fail-open).
 */
export async function readDownSlots(
  redis: Redis,
  candidates: readonly RouterName[],
): Promise<Set<RouterName>> {
  if (candidates.length === 0) return new Set();
  try {
    const keys = candidates.map(keyFor);
    const values = await redis.mget(...keys);
    const down = new Set<RouterName>();
    values.forEach((v, i) => {
      if (v) down.add(candidates[i]);
    });
    return down;
  } catch (e) {
    console.warn('[ai-router] readDownSlots failed — fail-open:', e);
    return new Set();
  }
}

/**
 * Which AdapterError kinds should trigger a slot-cooldown mark. Auth /
 * bad_request are caller-scoped and specific to a single request — they must
 * NOT cool the slot for other callers. model_not_available is model-scoped,
 * not slot-scoped, so also excluded (a slot that doesn't offer model X may
 * still serve model Y fine).
 */
export const COOLDOWN_TRIGGER_KINDS: ReadonlySet<string> = new Set([
  'insufficient_credits',
  'transport',
  'rate_limit',
  'unknown',
]);
