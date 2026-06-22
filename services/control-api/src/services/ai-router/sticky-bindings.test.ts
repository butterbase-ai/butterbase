import { describe, it, expect } from 'vitest';
import {
  createStickyBindings,
  sessionKey,
  prefixKey,
  hashCacheablePrefix,
  ttlSecondsFor,
} from './sticky-bindings.js';

// ---------------------------------------------------------------------------
// In-memory KV fixture — implements the KVClient interface with real TTL timers
// ---------------------------------------------------------------------------
function memoryKv() {
  const store = new Map<string, string>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  return {
    async get(key: string): Promise<string | null> {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
      store.set(key, value);
      if (opts?.expirationTtl !== undefined) {
        const existing = timers.get(key);
        if (existing) clearTimeout(existing);
        const t = setTimeout(() => {
          store.delete(key);
          timers.delete(key);
        }, opts.expirationTtl * 1000);
        timers.set(key, t);
      }
    },
    async delete(key: string): Promise<void> {
      const existing = timers.get(key);
      if (existing) clearTimeout(existing);
      timers.delete(key);
      store.delete(key);
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------

describe('sticky bindings', () => {
  it('returns null when no binding exists', async () => {
    const s = createStickyBindings(memoryKv());
    expect(await s.get(sessionKey('conv1'))).toBeNull();
  });

  it('round-trips a binding', async () => {
    const s = createStickyBindings(memoryKv());
    await s.set(sessionKey('conv1'), 'openrouter', 300);
    expect(await s.get(sessionKey('conv1'))).toBe('openrouter');
  });

  it('expires after ttl', async () => {
    const kv = memoryKv();
    const s = createStickyBindings(kv);
    await s.set(sessionKey('conv1'), 'openrouter', 1);
    await sleep(1100);
    expect(await s.get(sessionKey('conv1'))).toBeNull();
  });
});

describe('hashCacheablePrefix', () => {
  it('produces identical hashes for identical prefixes', () => {
    const a = { messages: [{ role: 'system', content: 'X' }, { role: 'user', content: 'Q1' }] };
    const b = { messages: [{ role: 'system', content: 'X' }, { role: 'user', content: 'Q2' }] };
    // last user turn excluded, so the prefix is the same
    expect(hashCacheablePrefix(a as any)).toBe(hashCacheablePrefix(b as any));
  });

  it('produces different hashes when system changes', () => {
    const a = { messages: [{ role: 'system', content: 'X' }, { role: 'user', content: 'Q' }] };
    const b = { messages: [{ role: 'system', content: 'Y' }, { role: 'user', content: 'Q' }] };
    expect(hashCacheablePrefix(a as any)).not.toBe(hashCacheablePrefix(b as any));
  });
});

describe('ttlSecondsFor', () => {
  it('returns 300 for default cache_control', () => {
    expect(ttlSecondsFor({ cache_control: { type: 'ephemeral' } } as any)).toBe(300);
  });

  it('returns 3600 for ttl=1h', () => {
    expect(ttlSecondsFor({ cache_control: { type: 'ephemeral', ttl: '1h' } } as any)).toBe(3600);
  });
});
