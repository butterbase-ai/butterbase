import { describe, it, expect } from 'vitest';
import { applyMarkup } from './markup.js';

describe('applyMarkup', () => {
  it('applies the percentage as a multiplier', () => {
    expect(applyMarkup(1.00, 20)).toBeCloseTo(1.20, 6);
    expect(applyMarkup(0.50, 0)).toBeCloseTo(0.50, 6);
    expect(applyMarkup(2.00, 100)).toBeCloseTo(4.00, 6);
  });

  it('returns 0 when provider cost is 0', () => {
    expect(applyMarkup(0, 20)).toBe(0);
  });

  it('clamps negative provider cost to 0', () => {
    expect(applyMarkup(-1, 20)).toBe(0);
  });

  it('clamps markup to [0, 200] regardless of input', () => {
    expect(applyMarkup(1, -10)).toBe(1);
    expect(applyMarkup(1, 500)).toBeCloseTo(3, 6);
  });
});
