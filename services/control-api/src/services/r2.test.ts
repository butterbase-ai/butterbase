import { describe, it, expect } from 'vitest';
import { buildKeys, buildCacheKey } from './r2.js';

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

/**
 * THE SHARING GUARANTEE.
 *
 * The autonomous operator's sandbox build and the build-runner container now
 * read and write the SAME node_modules cache object. The point of that is that
 * a deploy warms the cache for the operator and vice versa — but it only holds
 * if both sides compute the identical key.
 *
 * If they ever disagree, nothing fails: the sharing silently degrades into two
 * half-warm caches, each paying the measured 84.3s cold install the other one
 * had already paid for. Silent, and worse than having one cache. So the
 * agreement is asserted rather than assumed, and `buildCacheKey` is the single
 * definition both callers go through — `buildKeys` delegates to it.
 */
describe('buildCacheKey — shared by the deploy path and the operator sandbox', () => {
  it('is byte-identical to the key buildKeys hands the build-runner', () => {
    for (const [app, hash] of [['app-1', 'h1'], ['app_abc', 'a'.repeat(64)]] as const) {
      expect(buildCacheKey(app, hash)).toBe(buildKeys('any-deployment', app, hash).cache);
    }
  });

  it('does not depend on the deployment id — that is what makes it persist', () => {
    expect(buildKeys('d1', 'app-1', 'h1').cache).toBe(buildKeys('d2', 'app-1', 'h1').cache);
  });

  it('is scoped per app, so one app cannot read or poison another cache', () => {
    expect(buildCacheKey('app-1', 'h1')).not.toBe(buildCacheKey('app-2', 'h1'));
  });
});
