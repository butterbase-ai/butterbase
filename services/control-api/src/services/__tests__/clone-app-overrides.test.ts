import { describe, it, expect, beforeEach } from 'vitest';
import {
  parseCloneAppOverrides,
  resolveOverridesForClone,
  getCloneAppOverrides,
  __resetForTests,
} from '../clone-app-overrides.js';

describe('parseCloneAppOverrides', () => {
  it('returns {} when raw is undefined', () => {
    expect(parseCloneAppOverrides(undefined)).toEqual({});
  });

  it('returns {} when raw is empty string', () => {
    expect(parseCloneAppOverrides('')).toEqual({});
  });

  it('parses a valid blob with mint_hex and static entries', () => {
    const raw = JSON.stringify({
      app_source_a: {
        S1: { type: 'mint_hex', bytes: 32 },
        M1: { type: 'static', value: 'model-x' },
      },
    });
    const parsed = parseCloneAppOverrides(raw);
    expect(parsed.app_source_a.S1).toEqual({ type: 'mint_hex', bytes: 32 });
    expect(parsed.app_source_a.M1).toEqual({ type: 'static', value: 'model-x' });
  });

  it('throws on malformed JSON', () => {
    expect(() => parseCloneAppOverrides('{not json')).toThrow(/CLONE_APP_ENV_OVERRIDES/);
  });

  it('throws on unknown spec.type', () => {
    const raw = JSON.stringify({ app_x: { K: { type: 'wat', value: 'x' } } });
    expect(() => parseCloneAppOverrides(raw)).toThrow(/unknown override type/);
  });

  it('throws when mint_hex bytes below range', () => {
    const raw = JSON.stringify({ app_x: { K: { type: 'mint_hex', bytes: 8 } } });
    expect(() => parseCloneAppOverrides(raw)).toThrow(/bytes/);
  });

  it('throws when mint_hex bytes above range', () => {
    const raw = JSON.stringify({ app_x: { K: { type: 'mint_hex', bytes: 256 } } });
    expect(() => parseCloneAppOverrides(raw)).toThrow(/bytes/);
  });

  it('throws when static.value is not a string', () => {
    const raw = JSON.stringify({ app_x: { K: { type: 'static', value: 42 } } });
    expect(() => parseCloneAppOverrides(raw)).toThrow(/value/);
  });

  it('throws when top-level is not a plain object', () => {
    expect(() => parseCloneAppOverrides('[]')).toThrow(/object/);
  });
});

describe('resolveOverridesForClone', () => {
  it('returns {} when sourceAppId has no entry', () => {
    const overrides = parseCloneAppOverrides(
      JSON.stringify({ app_a: { K: { type: 'static', value: 'v' } } }),
    );
    expect(resolveOverridesForClone(overrides, 'app_b')).toEqual({});
  });

  it('passes static values through verbatim', () => {
    const overrides = parseCloneAppOverrides(
      JSON.stringify({ app_a: { K: { type: 'static', value: 'v1' } } }),
    );
    expect(resolveOverridesForClone(overrides, 'app_a')).toEqual({ K: 'v1' });
  });

  it('mint_hex produces a hex string of 2*bytes chars', () => {
    const overrides = parseCloneAppOverrides(
      JSON.stringify({ app_a: { K: { type: 'mint_hex', bytes: 32 } } }),
    );
    const out = resolveOverridesForClone(overrides, 'app_a');
    expect(out.K).toMatch(/^[0-9a-f]{64}$/);
  });

  it('mint_hex produces a fresh value on every call', () => {
    const overrides = parseCloneAppOverrides(
      JSON.stringify({ app_a: { K: { type: 'mint_hex', bytes: 32 } } }),
    );
    const a = resolveOverridesForClone(overrides, 'app_a').K;
    const b = resolveOverridesForClone(overrides, 'app_a').K;
    expect(a).not.toEqual(b);
  });

  it('returns the same value across every key in a single call', () => {
    // mint_hex is resolved per (call, key). Two mint_hex keys in the same
    // call must not share bytes — they are independent slots.
    const overrides = parseCloneAppOverrides(
      JSON.stringify({
        app_a: {
          K1: { type: 'mint_hex', bytes: 32 },
          K2: { type: 'mint_hex', bytes: 32 },
        },
      }),
    );
    const out = resolveOverridesForClone(overrides, 'app_a');
    expect(out.K1).not.toEqual(out.K2);
  });
});

describe('getCloneAppOverrides singleton', () => {
  beforeEach(() => __resetForTests());

  it('reads process.env.CLONE_APP_ENV_OVERRIDES once', () => {
    process.env.CLONE_APP_ENV_OVERRIDES = JSON.stringify({
      app_x: { K: { type: 'static', value: 'v' } },
    });
    const a = getCloneAppOverrides();
    process.env.CLONE_APP_ENV_OVERRIDES = JSON.stringify({});
    const b = getCloneAppOverrides();
    expect(a).toBe(b); // memoized
    delete process.env.CLONE_APP_ENV_OVERRIDES;
  });

  it('returns {} when env var is unset', () => {
    delete process.env.CLONE_APP_ENV_OVERRIDES;
    expect(getCloneAppOverrides()).toEqual({});
  });
});
