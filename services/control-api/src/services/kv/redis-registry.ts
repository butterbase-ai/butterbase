import { Redis } from 'ioredis';

const clients = new Map<string, Redis>();

function envKeyForRegion(region: string): string {
  return `KV_REDIS_URL_${region.toUpperCase().replace(/-/g, '_')}`;
}

export function kvRedisFor(region: string): Redis {
  let client = clients.get(region);
  if (client) return client;
  const url = process.env[envKeyForRegion(region)];
  if (!url) {
    throw new Error(`Missing environment variable: ${envKeyForRegion(region)}`);
  }
  client = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 2 });
  clients.set(region, client);
  return client;
}

export async function shutdownAllKvRedisClients(): Promise<void> {
  await Promise.all(Array.from(clients.values()).map((c) => c.quit().catch(() => {})));
  clients.clear();
}
