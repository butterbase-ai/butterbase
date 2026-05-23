import type { RedisClient } from './redis-client.js';

export async function checkRateLimit(
  client: RedisClient,
  appId: string,
  opsCost: number,
  maxOpsPerSec: number,
): Promise<{ allowed: true } | { allowed: false; retryAfterSec: number }> {
  const bucket = Math.floor(Date.now() / 1000);
  const key = `{${appId}}:_meta:rate:${bucket}`;
  const current = await client.incrBy(key, opsCost);
  if (current === opsCost) {
    // First hit in this second: set TTL so this key clears
    await client.expire(key, 2);
  }
  if (current > maxOpsPerSec) {
    return { allowed: false, retryAfterSec: 1 };
  }
  return { allowed: true };
}
