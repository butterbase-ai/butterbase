/**
 * Phase 3 E2E — Distributed lease pattern via Redis SETNX
 *
 * The actual Phase 3 lease primitive (verified via grep):
 *
 *   tryClaimShortLivedJob(redis: Redis, jobName: string, ttlSeconds: number): Promise<boolean>
 *   — services/cron-scheduler/src/distributed-lock.ts
 *
 * Internally it builds key = `cron:platform:<jobName>:<unix-seconds-bucket>`,
 * then does redis.set(key, region, 'EX', ttlSeconds, 'NX').
 * Returns true if this instance wins the lock, false otherwise.
 *
 * Key design consequence for the TTL test:
 *   The per-second bucket in the key changes every second. To observe "lock expired
 *   and a new claimer wins" we wait 1500 ms so the bucket advances (new key) AND the
 *   previous TTL has expired. The new claimer gets a fresh key with no existing lock.
 *
 * Note: The parallel-claim test works because all 10 Promise.all calls share the
 * same sub-second window → same bucket key → only the first SET NX succeeds.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Redis } from 'ioredis';
import { tryClaimShortLivedJob } from '../../services/cron-scheduler/src/distributed-lock.js';

let redis: Redis;

beforeAll(() => {
  redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
});

afterAll(async () => {
  await redis.flushdb();
  await redis.quit();
});

describe('Phase 3 — tryClaimShortLivedJob lease pattern', () => {
  it('only one of N parallel claimers wins per key (same second bucket)', async () => {
    // All 10 invocations happen in the same sub-second window so they all resolve
    // to the same Redis key. Exactly one SET NX will succeed.
    const jobName = `e2e-lease-parallel-${Date.now()}`;
    const claims = await Promise.all(
      Array.from({ length: 10 }, () => tryClaimShortLivedJob(redis, jobName, 5)),
    );
    const winners = claims.filter(c => c === true).length;
    expect(winners).toBe(1);
  });

  it('after the per-second bucket advances, a new claimer wins', async () => {
    // Use a unique jobName so this test is isolated from the parallel test above.
    const jobName = `e2e-lease-ttl-${Date.now()}`;

    // First claimer wins the current second-bucket.
    const first = await tryClaimShortLivedJob(redis, jobName, 1);
    expect(first).toBe(true);

    // Immediate retry on the same bucket → should lose.
    const immediate = await tryClaimShortLivedJob(redis, jobName, 1);
    expect(immediate).toBe(false);

    // Wait 1.5 s so that:
    //   (a) the per-second bucket in the key increments → new key, no existing lock.
    //   (b) the old key's TTL (1 s) also expires (belt-and-suspenders).
    await new Promise(r => setTimeout(r, 1500));

    // New second bucket → new Redis key → SET NX succeeds.
    const after = await tryClaimShortLivedJob(redis, jobName, 1);
    expect(after).toBe(true);
  });
});
