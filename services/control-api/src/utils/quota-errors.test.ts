import { describe, it, expect } from 'vitest';
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
