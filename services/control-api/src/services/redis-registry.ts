import { Redis } from 'ioredis';

const clients = new Map<string, Redis>();

function envKeyForRegion(region: string): string {
  return `REDIS_URL_${region.toUpperCase().replace(/-/g, '_')}`;
}

export function redisFor(region: string): Redis {
  let client = clients.get(region);
  if (client) return client;
  const url = process.env[envKeyForRegion(region)] ?? process.env.REDIS_URL ?? 'redis://localhost:6379';
  client = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 2 });
  clients.set(region, client);
  return client;
}

export async function shutdownAllRedisClients(): Promise<void> {
  await Promise.all(Array.from(clients.values()).map((c) => c.quit().catch(() => {})));
  clients.clear();
}
