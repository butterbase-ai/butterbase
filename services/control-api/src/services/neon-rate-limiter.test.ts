import { describe, it, expect } from 'vitest';
import { TokenBucket } from './neon-rate-limiter.js';

/** Fake clock: `sleep` advances virtual time instead of waiting. */
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => { t += ms; },
    advance: (ms: number) => { t += ms; },
    elapsed: () => t,
  };
}

describe('TokenBucket', () => {
  it('allows a full burst immediately without sleeping', async () => {
    const clock = fakeClock();
    const bucket = new TokenBucket({ ratePerSecond: 10, burst: 20, now: clock.now, sleep: clock.sleep });

    for (let i = 0; i < 20; i++) await bucket.acquire();

    expect(clock.elapsed()).toBe(0);
  });

  it('sleeps once the burst is exhausted', async () => {
    const clock = fakeClock();
    const bucket = new TokenBucket({ ratePerSecond: 10, burst: 2, now: clock.now, sleep: clock.sleep });

    await bucket.acquire();
    await bucket.acquire();
    await bucket.acquire(); // must wait ~100ms for one token at 10rps

    expect(clock.elapsed()).toBeGreaterThanOrEqual(100);
  });

  it('refills over elapsed time', async () => {
    const clock = fakeClock();
    const bucket = new TokenBucket({ ratePerSecond: 10, burst: 5, now: clock.now, sleep: clock.sleep });

    for (let i = 0; i < 5; i++) await bucket.acquire();
    clock.advance(1000); // 1s at 10rps refills to the burst cap of 5

    for (let i = 0; i < 5; i++) await bucket.acquire();
    expect(clock.elapsed()).toBe(1000); // no additional sleeping
  });

  it('never exceeds the burst cap when idle for a long time', async () => {
    const clock = fakeClock();
    const bucket = new TokenBucket({ ratePerSecond: 10, burst: 3, now: clock.now, sleep: clock.sleep });

    clock.advance(60_000); // idle a minute

    await bucket.acquire();
    await bucket.acquire();
    await bucket.acquire();
    await bucket.acquire(); // 4th must still wait — cap is 3

    expect(clock.elapsed()).toBeGreaterThan(60_000);
  });

  it('serialises concurrent acquires so they do not all take the same token', async () => {
    const clock = fakeClock();
    const bucket = new TokenBucket({ ratePerSecond: 10, burst: 1, now: clock.now, sleep: clock.sleep });

    await Promise.all([bucket.acquire(), bucket.acquire(), bucket.acquire()]);

    // 1 free + 2 that each wait ~100ms
    expect(clock.elapsed()).toBeGreaterThanOrEqual(200);
  });
});
