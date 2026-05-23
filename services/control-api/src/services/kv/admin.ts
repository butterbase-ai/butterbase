// src/admin.ts
// Admin-only endpoints for kv-gateway: _scan, _stats, _flush.
// All functions take a factory that opens a RedisClient for a given DB so the
// caller (worker.ts) owns connection lifecycle via withRedis.

import { RedisClient, RedisClientOptions } from './redis-client.js';
import { getStorageBytes, resetCounter } from './storage-counter.js';
import { getKeys } from './keys-counter.js';
import type { KvLimits } from './limits.js';

const SCAN_DEFAULT_LIMIT = 100;
const SCAN_MAX_LIMIT = 1000;

// Open a short-lived RedisClient for a specific DB, run fn, always close.
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

// Scan all keys matching `pattern` in a single DB, collecting into `out`.
// Returns the union of all pages (full scan, cursor = "0" → done).
async function scanAllKeys(
  baseOpts: Omit<RedisClientOptions, 'db'>,
  db: number,
  pattern: string,
): Promise<string[]> {
  const out: string[] = [];
  await withDb(baseOpts, db, async (c) => {
    let cursor = '0';
    do {
      const [next, keys] = await c.scan(cursor, pattern, SCAN_DEFAULT_LIMIT);
      out.push(...keys);
      cursor = next;
    } while (cursor !== '0');
  });
  return out;
}

// Strip the stored key form `{appId}:u:<userKey>` → `<userKey>`.
function stripPrefix(appId: string, stored: string): string | null {
  const prefix = `{${appId}}:u:`;
  if (!stored.startsWith(prefix)) return null;
  return stored.slice(prefix.length);
}

// ── _scan ─────────────────────────────────────────────────────────────────────

export interface ScanResult {
  keys: string[];
  cursor: string;
}

/**
 * Scan user keys for an app across durable (DB 0) + ephemeral (DB 1).
 * Returns user-facing keys (strips the `{appId}:u:` prefix).
 * Unions both DBs and deduplicates. cursor/limit are accepted but the current
 * implementation does a full scan per call (stateless). cursor "0" means done.
 */
export async function scanKeys(
  baseOpts: Omit<RedisClientOptions, 'db'>,
  appId: string,
  opts: { prefix?: string; limit?: number },
): Promise<ScanResult> {
  const limit = Math.min(opts.limit ?? SCAN_DEFAULT_LIMIT, SCAN_MAX_LIMIT);
  const userPrefix = opts.prefix ?? '';
  const pattern = `{${appId}}:u:${userPrefix}*`;

  // Collect from both DBs sequentially to avoid shared-state races.
  const db0Keys = await scanAllKeys(baseOpts, 0, pattern);
  const db1Keys = await scanAllKeys(baseOpts, 1, pattern);

  // Union + deduplicate, strip prefix, apply limit.
  const seen = new Set<string>();
  const result: string[] = [];
  for (const stored of [...db0Keys, ...db1Keys]) {
    const userKey = stripPrefix(appId, stored);
    if (userKey === null) continue;
    if (seen.has(userKey)) continue;
    seen.add(userKey);
    result.push(userKey);
    if (result.length >= limit) break;
  }

  return { keys: result, cursor: '0' };
}

// ── _stats ────────────────────────────────────────────────────────────────────

export interface StatsResult {
  keys_total: number;
  bytes_used: number;
  ops_per_sec: number | null;
  max_keys: number;
  max_storage_bytes: number;
  max_ops_per_sec: number;
  max_value_bytes: number;
}

/**
 * Returns real stats for an app:
 *   bytes_used  — O(1) read from the running counter at `{appId}:_meta:bytes`.
 *   ops_per_sec — current-second rate-limit bucket (maintained by Task 3).
 *   keys_total  — O(1) read from the keys counter at `{appId}:_meta:keys`.
 *   max_*       — plan limits for the app.
 */
export async function appStats(
  baseOpts: Omit<RedisClientOptions, 'db'>,
  appId: string,
  limits: KvLimits,
): Promise<StatsResult> {
  const metaClient = await RedisClient.connect({ ...baseOpts, db: 0 });
  let bytesUsed = 0;
  let keysTotal = 0;
  let opsPerSec = 0;
  try {
    bytesUsed = await getStorageBytes(metaClient, appId);
    keysTotal = await getKeys(metaClient, appId);
    const bucket = Math.floor(Date.now() / 1000);
    const opsRaw = await metaClient.get(`{${appId}}:_meta:rate:${bucket}`);
    opsPerSec = opsRaw ? parseInt(opsRaw, 10) : 0;
  } finally {
    await metaClient.close();
  }
  return {
    keys_total: keysTotal,
    bytes_used: bytesUsed,
    ops_per_sec: opsPerSec,
    max_keys: limits.maxKeysTotal,
    max_storage_bytes: limits.maxStorageBytes,
    max_ops_per_sec: limits.maxOpsPerSec,
    max_value_bytes: limits.maxValueBytes,
  };
}

// ── _flush ────────────────────────────────────────────────────────────────────

export interface FlushResult {
  deleted: number;
}

/**
 * Flush all user data for an app from both DBs.
 * Deletes `{appId}:u:*` and `{appId}:_ttl:*` in both DBs.
 * If include_config is true, also deletes `{appId}:_meta:expose`.
 * Expose rules are preserved by default.
 */
export async function flushApp(
  baseOpts: Omit<RedisClientOptions, 'db'>,
  appId: string,
  opts: { include_config?: boolean },
): Promise<FlushResult> {
  const patterns = [
    `{${appId}}:u:*`,
    `{${appId}}:_ttl:*`,
  ];
  if (opts.include_config) {
    patterns.push(`{${appId}}:_meta:expose`);
  }

  let deleted = 0;

  async function flushDb(db: number) {
    await withDb(baseOpts, db, async (c) => {
      for (const pattern of patterns) {
        // Use SCAN to find keys; UNLINK for non-blocking deletion.
        let cursor = '0';
        do {
          const [next, keys] = await c.scan(cursor, pattern, SCAN_DEFAULT_LIMIT);
          if (keys.length > 0) {
            deleted += await c.unlink(keys);
          }
          cursor = next;
        } while (cursor !== '0');
      }
    });
  }

  // Sequential to avoid shared-state races on the `deleted` accumulator.
  await flushDb(0);
  await flushDb(1);

  // Reset the running storage-byte counter so it doesn't drift after a flush.
  const metaClient = await RedisClient.connect({ ...baseOpts, db: 0 });
  try {
    await resetCounter(metaClient, appId);
  } finally {
    await metaClient.close();
  }

  return { deleted };
}
