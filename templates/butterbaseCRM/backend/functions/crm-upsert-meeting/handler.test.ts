import { describe, expect, it } from 'vitest';
import { attrsEqual } from './handler';

describe('meeting attrs comparison', () => {
  it('ignores updated_at and key order', () => {
    expect(attrsEqual(
      { title: 'A', starts_at: 'x' },
      { starts_at: 'x', title: 'A', updated_at: 'y' },
    )).toBe(true);
  });

  it('detects a real change', () => {
    expect(attrsEqual({ title: 'A' }, { title: 'B' })).toBe(false);
  });

  it('compares nested values', () => {
    expect(attrsEqual({ custom_fields: { a: 1 } }, { custom_fields: { a: 1 } })).toBe(true);
    expect(attrsEqual({ custom_fields: { a: 1 } }, { custom_fields: { a: 2 } })).toBe(false);
  });
});
