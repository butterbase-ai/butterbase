import { describe, it, expect } from 'vitest';
import { computeRetryDelayMs } from './neon-client.js';

const BACKOFF = [500, 1000, 2000, 4000, 8000];

describe('computeRetryDelayMs', () => {
  it('returns null for success and for non-retryable client errors', () => {
    expect(computeRetryDelayMs(200, null, 1, BACKOFF)).toBeNull();
    expect(computeRetryDelayMs(400, null, 1, BACKOFF)).toBeNull();
    expect(computeRetryDelayMs(404, null, 1, BACKOFF)).toBeNull();
    expect(computeRetryDelayMs(409, null, 1, BACKOFF)).toBeNull();
  });

  it('retries 423 with the positional backoff', () => {
    expect(computeRetryDelayMs(423, null, 1, BACKOFF)).toBe(500);
    expect(computeRetryDelayMs(423, null, 3, BACKOFF)).toBe(2000);
  });

  it('retries 5xx with the positional backoff', () => {
    expect(computeRetryDelayMs(500, null, 1, BACKOFF)).toBe(500);
    expect(computeRetryDelayMs(503, null, 2, BACKOFF)).toBe(1000);
  });

  it('retries 429 even with no Retry-After header', () => {
    expect(computeRetryDelayMs(429, null, 1, BACKOFF)).toBe(500);
  });

  it('honours a numeric Retry-After (seconds) on 429', () => {
    expect(computeRetryDelayMs(429, '3', 1, BACKOFF)).toBe(3000);
  });

  it('prefers Retry-After over backoff when it is longer', () => {
    expect(computeRetryDelayMs(429, '30', 1, BACKOFF)).toBe(30_000);
  });

  it('ignores an unparseable Retry-After and falls back to backoff', () => {
    expect(computeRetryDelayMs(429, 'Wed, 21 Oct 2026 07:28:00 GMT', 1, BACKOFF)).toBe(500);
  });

  it('clamps past the end of the backoff table', () => {
    expect(computeRetryDelayMs(423, null, 99, BACKOFF)).toBe(8000);
  });
});
