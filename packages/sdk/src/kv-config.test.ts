import { describe, it, expect } from 'vitest';
import { defineKvConfig, type KvConfigInput } from './kv-config.js';

describe('defineKvConfig', () => {
  it('returns the input unchanged (identity helper for type inference)', () => {
    const cfg = defineKvConfig({
      expose: [
        { pattern: 'flags:*', read: 'public', write: 'deny' },
        { pattern: 'session:{user.id}:*', read: 'owner', write: 'owner' },
      ],
    });
    expect(cfg.expose).toHaveLength(2);
    expect(cfg.expose[0].pattern).toBe('flags:*');
  });

  it('types reject invalid roles', () => {
    // @ts-expect-error — "admin" is not a valid role
    defineKvConfig({ expose: [{ pattern: 'x', read: 'admin', write: 'deny' }] });
  });
});
