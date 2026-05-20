import { describe, it, expect } from 'vitest';
import {
  generateCode,
  hashCode,
  verifyCode,
  validateCustomCode,
} from '../services/hackathons/codes.js';

describe('hackathon codes', () => {
  it('generateCode produces a K7M2-9XQR style 9-char string', () => {
    const c = generateCode();
    expect(c).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}$/);
  });

  it('hashCode + verifyCode round-trip', async () => {
    const c = generateCode();
    const h = await hashCode(c);
    expect(h).not.toEqual(c);
    expect(await verifyCode(c, h)).toBe(true);
    expect(await verifyCode('WRONG-CODE', h)).toBe(false);
  });

  it('validateCustomCode accepts 8-64 printable ASCII, no whitespace', () => {
    expect(validateCustomCode('K7M2-9XQR')).toEqual({ ok: true });
    expect(validateCustomCode('a'.repeat(64))).toEqual({ ok: true });
  });

  it('validateCustomCode rejects too short / too long / whitespace / control chars / common defaults', () => {
    expect(validateCustomCode('short').ok).toBe(false);
    expect(validateCustomCode('a'.repeat(65)).ok).toBe(false);
    expect(validateCustomCode('has space').ok).toBe(false);
    expect(validateCustomCode('has\ttab').ok).toBe(false);
    expect(validateCustomCode('password').ok).toBe(false);
    expect(validateCustomCode('12345678').ok).toBe(false);
    expect(validateCustomCode('  trim-me  ').ok).toBe(false);
  });
});
