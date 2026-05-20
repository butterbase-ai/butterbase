import { Redis } from 'ioredis';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const REDIS_OPTIONS = {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  lazyConnect: false,
};

let commandClient: Redis | null = null;
let pubClient: Redis | null = null;
let subClient: Redis | null = null;

type MessageHandler = (channel: string, message: string) => void;
const messageHandlers: MessageHandler[] = [];

export function getRedisClient(): Redis {
  if (!commandClient) {
    commandClient = new Redis(REDIS_URL, REDIS_OPTIONS);
    commandClient.on('error', (err) => console.error('[Redis:cmd] error:', err.message));
  }
  return commandClient;
}

export function getRedisPubClient(): Redis {
  if (!pubClient) {
    pubClient = new Redis(REDIS_URL, REDIS_OPTIONS);
    pubClient.on('error', (err) => console.error('[Redis:pub] error:', err.message));
  }
  return pubClient;
}

export function getRedisSubClient(): Redis {
  if (!subClient) {
    subClient = new Redis(REDIS_URL, REDIS_OPTIONS);
    subClient.on('error', (err) => console.error('[Redis:sub] error:', err.message));
    subClient.on('message', (channel: string, message: string) => {
      for (const handler of messageHandlers) {
        try { handler(channel, message); } catch (e) { console.error('[Redis:sub] handler error:', e); }
      }
    });
  }
  return subClient;
}

export function onRedisMessage(handler: MessageHandler): void {
  messageHandlers.push(handler);
}

export async function shutdownRedis(): Promise<void> {
  const clients = [commandClient, pubClient, subClient].filter(Boolean) as Redis[];
  await Promise.allSettled(clients.map((c) => c.quit()));
  commandClient = null;
  pubClient = null;
  subClient = null;
  messageHandlers.length = 0;
}
