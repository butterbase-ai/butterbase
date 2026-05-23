// src/admin.ts
// Admin-only endpoints for kv-gateway: _scan, _stats, _flush.
// All functions take a factory that opens a RedisClient for a given DB so the
// caller (worker.ts) owns connection lifecycle via withRedis.

import { RedisClient, RedisClientOptions } from './redis-client.js';

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
