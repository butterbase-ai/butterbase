import { describe, it, expect } from 'vitest';
import { quotaErrors } from './quota-errors.js';
import {
  kvRateLimited,
  kvCreditsExhausted,
  kvStorageFull,
  kvKeysExhausted,
} from './quota-errors.js';

describe('KV quota error helpers', () => {
  describe('kvRateLimited', () => {
    it('returns 429 with retry-after header', () => {
      const result = kvRateLimited(60);

      expect(result.statusCode).toBe(429);
      expect(result.headers).toEqual({ 'retry-after': '60' });
      expect(result.body).toEqual({
        error: 'kv_rate_limited',
        retry_after: 60,
      });
    });

    it('converts retry-after to string in header', () => {
      const result = kvRateLimited(120);

      expect(typeof result.headers!['retry-after']).toBe('string');
      expect(result.headers!['retry-after']).toBe('120');
    });
  });

  describe('kvCreditsExhausted', () => {
    it('returns 402 with credits exhausted error', () => {
      const result = kvCreditsExhausted();

      expect(result.statusCode).toBe(402);
      expect(result.body).toEqual({
        error: 'kv_credits_exhausted',
        message: 'Credit balance is 0. Top up or wait for monthly reset.',
      });
    });

    it('does not include headers', () => {
      const result = kvCreditsExhausted();

      expect(result.headers).toBeUndefined();
    });
  });

  describe('kvStorageFull', () => {
    it('returns 507 with storage usage info', () => {
      const result = kvStorageFull(1000000, 5000000);

      expect(result.statusCode).toBe(507);
      expect(result.body).toEqual({
        error: 'kv_storage_full',
        used_bytes: 1000000,
        cap_bytes: 5000000,
      });
    });

    it('handles zero values', () => {
      const result = kvStorageFull(0, 0);

      expect(result.body).toEqual({
        error: 'kv_storage_full',
        used_bytes: 0,
        cap_bytes: 0,
      });
    });
  });

  describe('kvKeysExhausted', () => {
    it('returns 507 with key count info', () => {
      const result = kvKeysExhausted(1000, 10000);

      expect(result.statusCode).toBe(507);
      expect(result.body).toEqual({
        error: 'kv_keys_exhausted',
        keys: 1000,
        cap: 10000,
      });
    });

    it('does not include headers', () => {
      const result = kvKeysExhausted(1000, 10000);

      expect(result.headers).toBeUndefined();
    });
  });
});

/**
 * Regression: this message named a "Pro plan", which does not exist on this
 * platform. The tiers are playground / launch / certified / enterprise. It went
 * unnoticed because every caller's test asserted the payload SHAPE — comparing
 * against quotaErrors.featureNotAvailable(...) itself — so both sides of the
 * assertion carried the same wrong string and it could never fail. A live call
 * against the running API is what surfaced it.
 */
describe('quotaErrors.featureNotAvailable', () => {
  const REAL_PLANS = ['playground', 'launch', 'certified', 'enterprise'];

  it('names a plan that actually exists', () => {
    const msg = quotaErrors.featureNotAvailable('staging').message.toLowerCase();
    expect(REAL_PLANS.some((p) => msg.includes(p))).toBe(true);
  });

  it('does not invent a plan tier', () => {
    const msg = quotaErrors.featureNotAvailable('staging').message;
    // Word-boundary matched so a future "Pro-rated" or similar does not trip it.
    expect(msg).not.toMatch(/pro/i);
    expect(msg).not.toMatch(/premium/i);
    expect(msg).not.toMatch(/team/i);
  });

  it('carries the feature name and an upgrade path', () => {
    const e = quotaErrors.featureNotAvailable('custom_domain');
    expect(e.error).toBe('feature_not_available');
    expect(e.feature).toBe('custom_domain');
    expect(e.upgradeUrl).toBeTruthy();
  });
});
