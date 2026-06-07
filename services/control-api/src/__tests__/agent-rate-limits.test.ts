import { describe, it, expect, beforeAll } from 'vitest';
import { Redis as IORedis } from 'ioredis';
import {
  checkAndIncrementCounter,
  resetCounterKey,
  type LimitDef,
} from '../services/agent-rate-limits.js';

const redis = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379');

beforeAll(async () => {
  const keys = await redis.keys('agent_rl_test:*');
  if (keys.length) await redis.del(...keys);
});

describe('checkAndIncrementCounter', () => {
  it('allows up to the limit then rejects', async () => {
    const def: LimitDef = { key: 'agent_rl_test:user:1', limit: 3, windowSeconds: 60 };
    const a = await checkAndIncrementCounter(redis, def);
    const b = await checkAndIncrementCounter(redis, def);
    const c = await checkAndIncrementCounter(redis, def);
    const d = await checkAndIncrementCounter(redis, def);
    expect(a.allowed).toBe(true);
    expect(b.allowed).toBe(true);
    expect(c.allowed).toBe(true);
    expect(d.allowed).toBe(false);
    expect(d.current).toBe(3);
    expect(d.max).toBe(3);
    expect(d.resetAt).toBeGreaterThan(Date.now() / 1000);
  });

  it('returns allowed when limit is null/undefined', async () => {
    const r = await checkAndIncrementCounter(redis, {
      key: 'agent_rl_test:user:noop', limit: null, windowSeconds: 60,
    });
    expect(r.allowed).toBe(true);
  });
});
