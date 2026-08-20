import { describe, it, expect } from 'vitest';
import { positiveIntOr } from './config.js';

describe('positiveIntOr (Neon rate-limit env parsing)', () => {
  it('accepts a valid positive integer', () => {
    expect(positiveIntOr('25', 10)).toBe(25);
  });

  it('falls back when unset', () => {
    expect(positiveIntOr(undefined, 10)).toBe(10);
    expect(positiveIntOr('', 20)).toBe(20);
  });

  it('falls back on 0 — a 0 rate would throw inside TokenBucket at import time', () => {
    expect(positiveIntOr('0', 10)).toBe(10);
  });

  it('falls back on negative values', () => {
    expect(positiveIntOr('-5', 20)).toBe(20);
  });

  it('falls back on non-numeric values instead of yielding NaN', () => {
    expect(positiveIntOr('abc', 10)).toBe(10);
    expect(positiveIntOr('  ', 20)).toBe(20);
  });

  it('truncates a decimal to its integer part when still positive', () => {
    expect(positiveIntOr('7.9', 10)).toBe(7);
  });
});
