import { describe, it, expect, vi } from 'vitest';
import { getHandle, BuildHandle } from './build-driver.service.js';

describe('build-driver', () => {
  it('returns undefined for unknown build ids', () => {
    expect(getHandle('does-not-exist')).toBeUndefined();
  });
});

describe('BuildHandle subscriber semantics', () => {
  it('replays buffered chunks to new subscribers', () => {
    const h = new BuildHandle('b1');
    h.push(Buffer.from('a'));
    h.push(Buffer.from('b'));
    const chunks: string[] = [];
    h.subscribe({ write: (c) => chunks.push(c.toString()), end: () => {} });
    expect(chunks).toEqual(['a', 'b']);
  });

  it('forwards live chunks to all subscribers', () => {
    const h = new BuildHandle('b2');
    const a: string[] = [];
    const b: string[] = [];
    h.subscribe({ write: (c) => a.push(c.toString()), end: () => {} });
    h.subscribe({ write: (c) => b.push(c.toString()), end: () => {} });
    h.push(Buffer.from('x'));
    expect(a).toEqual(['x']);
    expect(b).toEqual(['x']);
  });

  it('subscribers added after finish receive buffer then immediate end', () => {
    const h = new BuildHandle('b3');
    h.push(Buffer.from('done-msg'));
    h.finish(0, null);
    const chunks: string[] = [];
    let ended = false;
    h.subscribe({ write: (c) => chunks.push(c.toString()), end: () => { ended = true; } });
    expect(chunks).toEqual(['done-msg']);
    expect(ended).toBe(true);
  });

  it('does not call write on subscribers after finish', () => {
    const h = new BuildHandle('b4');
    const sub = { write: vi.fn(), end: vi.fn() };
    h.subscribe(sub);
    h.push(Buffer.from('a'));
    h.finish(0, null);
    expect(sub.end).toHaveBeenCalledTimes(1);
    // Push after finish should not reach the (now-cleared) subscriber.
    // We don't actually expect anyone to call push after finish in real code,
    // but pin that subscribers are no longer in the set.
    h.push(Buffer.from('b'));
    expect(sub.write).toHaveBeenCalledTimes(1); // only the pre-finish 'a'
  });
});
