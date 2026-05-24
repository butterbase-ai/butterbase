// services/control-api/src/services/kv/migration-sentinel.ts
// Per-app migration sentinel: blocks KV writes during app moves (Plan 6).
// Used by move-app saga and kv-quota plugin preHandler to synchronize.

import type { RedisClient } from './redis-client.js';

const KEY = (appId: string) => `{${appId}}:_meta:migration`;
const TTL_SEC = 3600; // 1h auto-clear so a crashed saga can't brick an app forever

/**
 * Set the KV block for an app during migration.
 * Uses SETEX for atomicity (single round-trip).
 */
export async function setKvBlock(client: RedisClient, appId: string): Promise<void> {
  await client.setex(KEY(appId), TTL_SEC, '1');
}

/**
 * Clear the KV block after migration completes (success or rollback).
 */
export async function clearKvBlock(client: RedisClient, appId: string): Promise<void> {
  await client.del([KEY(appId)]);
}

/**
 * Check if KV is blocked for this app.
 * Must be a single GET for speed (called once per write request by kv-quota plugin).
 */
export async function isKvBlocked(client: RedisClient, appId: string): Promise<boolean> {
  const v = await client.get(KEY(appId));
  return v !== null;
}
