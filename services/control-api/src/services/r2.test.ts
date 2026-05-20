import { describe, it, expect } from 'vitest';
import { buildKeys } from './r2.js';

describe('buildKeys', () => {
  it('produces all expected keys for a deployment', () => {
    const k = buildKeys('depl-1', 'app-1', 'abc123');
    expect(k.source).toBe('source/depl-1.zip');
    expect(k.artifact).toBe('artifact/depl-1.zip');
    expect(k.log).toBe('logs/depl-1.txt');
    expect(k.status).toBe('logs/depl-1.status.json');
    expect(k.cache).toBe('cache/app-1/abc123.tar');
  });

  it('does not collide for distinct deployments of the same app', () => {
    const a = buildKeys('depl-A', 'app-1', 'h1');
    const b = buildKeys('depl-B', 'app-1', 'h1');
    expect(a.source).not.toBe(b.source);
    expect(a.artifact).not.toBe(b.artifact);
    expect(a.log).not.toBe(b.log);
    // Cache key is intentionally shared per (app, lockfile_hash) — same hash → same cache.
    expect(a.cache).toBe(b.cache);
  });

  it('cache key changes when lockfile hash changes', () => {
    const a = buildKeys('d1', 'app-1', 'h1');
    const b = buildKeys('d1', 'app-1', 'h2');
    expect(a.cache).not.toBe(b.cache);
  });
});
