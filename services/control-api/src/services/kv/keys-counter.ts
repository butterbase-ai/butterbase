import type { RedisClient } from './redis-client.js';

const metaKey = (appId: string) => `{${appId}}:_meta:keys`;

export async function getKeys(client: RedisClient, appId: string): Promise<number> {
  const v = await client.get(metaKey(appId));
  return v ? parseInt(v, 10) : 0;
}

export async function incKeys(client: RedisClient, appId: string, delta: number): Promise<number> {
  return client.incrBy(metaKey(appId), Math.max(0, delta));
}

export async function decKeys(client: RedisClient, appId: string, delta: number): Promise<number> {
  return client.decrBy(metaKey(appId), Math.max(0, delta));
}

export async function resetKeysCounter(client: RedisClient, appId: string): Promise<void> {
  await client.del([metaKey(appId)]);
}
