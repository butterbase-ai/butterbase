/**
 * Per-app storage byte counter on KV Redis.
 *
 * Maintains a running counter at `{appId}:_meta:bytes` for the total bytes
 * used by all user keys in that app (across both DB 0 and DB 1).
 *
 * The counter is incremented/decremented by handlers on user-key writes,
 * and reconciled daily by the cron job to catch drift from crashes.
 *
 * exported API:
 *   getStorageBytes(client, appId) → Promise<number>
 *   incBytes(client, appId, delta) → Promise<number>
 *   decBytes(client, appId, delta) → Promise<number>
 *   resetCounter(client, appId) → Promise<void>
 *   reconcileFromScan(client, appId, baseOpts) → Promise<{ actual: number; previous: number }>
 */

import { RedisClient, type RedisClientOptions } from './redis-client.js';

const metaKey = (appId: string) => `{${appId}}:_meta:bytes`;

/**
 * Open a short-lived RedisClient for a specific DB, run fn, always close.
 * Used by reconcileFromScan to isolate DB-specific scans.
 */
async function withDb<T>(
  baseOpts: Omit<RedisClientOptions, 'db'>,
  db: number,
  fn: (c: RedisClient) => Promise<T>,
): Promise<T> {
  const c = await RedisClient.connect({ ...baseOpts, db });
  try {
    return await fn(c);
  } finally {
    await c.close();
  }
}

/**
 * Get the current storage byte count for an app.
 * Returns 0 if the counter does not exist.
 */
export async function getStorageBytes(client: RedisClient, appId: string): Promise<number> {
  const v = await client.get(metaKey(appId));
  return v ? parseInt(v, 10) : 0;
}

/**
 * Increment the storage byte counter by delta.
 * Clamps delta to 0 to prevent negative increments.
 * Returns the new counter value.
 */
export async function incBytes(client: RedisClient, appId: string, delta: number): Promise<number> {
  return client.incrBy(metaKey(appId), Math.max(0, delta));
}

/**
 * Decrement the storage byte counter by delta.
 * Clamps delta to 0 to prevent negative decrements.
 * Returns the new counter value.
 */
export async function decBytes(client: RedisClient, appId: string, delta: number): Promise<number> {
  return client.decrBy(metaKey(appId), Math.max(0, delta));
}

/**
 * Reset the storage byte counter to zero.
 */
export async function resetCounter(client: RedisClient, appId: string): Promise<void> {
  await client.del([metaKey(appId)]);
}

/**
 * Reconcile the storage byte counter via full scan of user keys.
 * Scans all keys matching `{appId}:u:*` in both DB 0 and DB 1,
 * sums their MEMORY USAGE, and updates the counter atomically.
 *
 * Returns { actual, previous } where actual is the sum of all MEMORY USAGE values
 * and previous is the old counter value before reconciliation.
 *
 * Expensive O(n) operation — use only for daily cron, not hot path.
 *
 * baseOpts (host, port, password) is required to create new RedisClient instances
 * for scanning each DB independently.
 */
export async function reconcileFromScan(
  client: RedisClient,
  appId: string,
  baseOpts: Omit<RedisClientOptions, 'db'>,
): Promise<{ actual: number; previous: number }> {
  const previous = await getStorageBytes(client, appId);
  const match = `{${appId}}:u:*`;
  let actual = 0;

  // Scan both DB 0 (durable) and DB 1 (ephemeral) sequentially.
  async function collectDb(db: number) {
    await withDb(baseOpts, db, async (c) => {
      let cursor = '0';
      do {
        const [next, keys] = await c.scan(cursor, match, 500);
        cursor = next;
        for (const k of keys) {
          const used = await c.memoryUsage(k);
          if (used !== null) {
            actual += used;
          }
        }
      } while (cursor !== '0');
    });
  }

  await collectDb(0);
  await collectDb(1);

  // Update the counter with the actual value.
  await client.set(metaKey(appId), String(actual));

  return { actual, previous };
}
