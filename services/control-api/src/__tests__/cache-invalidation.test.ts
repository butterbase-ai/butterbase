import { describe, it, expect, afterAll } from 'vitest';
import { invalidateFunctionCache } from '../utils/cache-invalidation.js';
import { getRedisSubClient, onRedisMessage, shutdownRedis } from '../services/redis.js';

afterAll(async () => {
  await shutdownRedis();
});

describe('cache invalidation via Redis pub/sub', () => {
  it('publishes invalidation message to correct channel', async () => {
    const received: string[] = [];
    const sub = getRedisSubClient();
    onRedisMessage((channel, message) => {
      if (channel === 'function:invalidate') received.push(message);
    });
    await sub.subscribe('function:invalidate');

    const result = await invalidateFunctionCache('app_123', 'my-func');

    await new Promise((r) => setTimeout(r, 100));
    expect(result.success).toBe(true);
    expect(received.length).toBe(1);
    const parsed = JSON.parse(received[0]);
    expect(parsed.app_id).toBe('app_123');
    expect(parsed.function_name).toBe('my-func');
  });
});
