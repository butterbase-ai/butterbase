import { describe, it, expect, afterAll } from 'vitest';
import { getRedisClient, getRedisPubClient, getRedisSubClient, onRedisMessage, shutdownRedis } from '../services/redis.js';

afterAll(async () => {
  await shutdownRedis();
});

describe('shared redis module', () => {
  it('returns the same command client on repeated calls', () => {
    const a = getRedisClient();
    const b = getRedisClient();
    expect(a).toBe(b);
  });

  it('returns separate pub and sub clients', () => {
    const pub = getRedisPubClient();
    const sub = getRedisSubClient();
    expect(pub).not.toBe(sub);
  });

  it('sub client dispatches messages to registered handlers', async () => {
    const sub = getRedisSubClient();
    const pub = getRedisPubClient();

    const received: string[] = [];
    onRedisMessage((channel, message) => {
      if (channel === 'test:channel') received.push(message);
    });

    await sub.subscribe('test:channel');
    await pub.publish('test:channel', 'hello');

    await new Promise((r) => setTimeout(r, 100));
    expect(received).toContain('hello');
  });
});
