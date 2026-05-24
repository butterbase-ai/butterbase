// services/control-api/src/services/kv/kv-scope.ts
// SCAN+UNLINK helper for clearing an app's KV scope across DB 0 + DB 1.
// Used by reverse-move (fast path) to pre-empty the destination before restore.

import { RedisClient, type RedisClientOptions } from './redis-client.js';
import { kvBaseOptsForRegion } from '../move-app/step-dump-kv.js';

/**
 * Delete every `{appId}:*` key on both DB 0 and DB 1 of the given region's
 * KV substrate. Uses UNLINK (async free) to avoid blocking Redis on large
 * scopes. Returns the count of keys removed across both DBs.
 *
 * Idempotent: a scope that is already empty returns 0.
 */
export async function clearKvScope(
  region: string,
  appId: string,
  baseOpts?: Omit<RedisClientOptions, 'db'>,
): Promise<number> {
  const opts = baseOpts ?? kvBaseOptsForRegion(region);
  const match = `{${appId}}:*`;
  let total = 0;

  for (const db of [0] as const) {
    const c = await RedisClient.connect({ ...opts, db });
    try {
      let cursor = '0';
      do {
        const [next, keys] = await c.scan(cursor, match, 500);
        cursor = next;
        if (keys.length > 0) {
          total += await c.unlink(keys);
        }
      } while (cursor !== '0');
    } finally {
      await c.close();
    }
  }
  return total;
}
