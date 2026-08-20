export interface TokenBucketOptions {
  /** Sustained rate. */
  ratePerSecond: number;
  /** Maximum tokens accumulated while idle. Defaults to ratePerSecond. */
  burst?: number;
  /** Injectable for tests. */
  now?: () => number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Classic token bucket, used to keep our Neon API call rate under the
 * account-wide budget (700 req/min, burst 40/s per route).
 *
 * `acquire()` calls are serialised through a promise chain so that N
 * concurrent callers consume N tokens rather than all observing the same
 * one. That serialisation is bookkeeping only — it does not make the
 * underlying HTTP calls sequential.
 */
export class TokenBucket {
  private tokens: number;
  private last: number;
  private readonly rate: number;
  private readonly burst: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private chain: Promise<void> = Promise.resolve();

  constructor(opts: TokenBucketOptions) {
    if (opts.ratePerSecond <= 0) throw new Error('TokenBucket: ratePerSecond must be > 0');
    this.rate = opts.ratePerSecond;
    this.burst = opts.burst ?? opts.ratePerSecond;
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => globalThis.setTimeout(r, ms)));
    this.tokens = this.burst;
    this.last = this.now();
  }

  async acquire(): Promise<void> {
    const run = this.chain.then(() => this.take());
    // Keep the chain alive even if a take() rejects.
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async take(): Promise<void> {
    for (;;) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const deficit = 1 - this.tokens;
      await this.sleep(Math.max(1, Math.ceil((deficit / this.rate) * 1000)));
    }
  }

  private refill(): void {
    const t = this.now();
    const elapsedSec = (t - this.last) / 1000;
    if (elapsedSec > 0) {
      this.tokens = Math.min(this.burst, this.tokens + elapsedSec * this.rate);
      this.last = t;
    }
  }
}
