import { describe, it, expect } from 'vitest';
import { planRetention, type SnapshotSummary } from './repo-retention.js';

const snap = (id: string, ts: number, blobs: string[]): SnapshotSummary => ({
  snapshotId: id,
  createdAt: new Date(ts),
  blobs: new Set(blobs),
});

describe('planRetention', () => {
  it('keeps everything when count <= retain', () => {
    const all = [snap('a', 1, ['x']), snap('b', 2, ['x', 'y'])];
    const plan = planRetention(all, new Set(), 5);
    expect(plan.retainSnapshots.sort()).toEqual(['a', 'b']);
    expect(plan.dropSnapshots).toEqual([]);
    expect(plan.orphanBlobs.size).toBe(0);
  });

  it('drops oldest beyond retain count', () => {
    const all = Array.from({ length: 7 }, (_, i) => snap(`s${i}`, i, [`b${i}`]));
    const plan = planRetention(all, new Set(), 5);
    expect(plan.dropSnapshots.sort()).toEqual(['s0', 's1']);
    expect(plan.orphanBlobs).toEqual(new Set(['b0', 'b1']));
  });

  it('always keeps pinned snapshots even if old', () => {
    const all = [
      snap('ancient', 0, ['old']),
      snap('s2', 2, ['y']),
      snap('s3', 3, ['y']),
      snap('s4', 4, ['z']),
      snap('s5', 5, ['z']),
      snap('s6', 6, ['w']),
      snap('s7', 7, ['v']),
    ];
    const plan = planRetention(all, new Set(['ancient']), 5);
    expect(plan.retainSnapshots).toContain('ancient');
    expect(plan.dropSnapshots).toEqual(['s2']);
  });

  it('does not orphan blobs still referenced by retained snapshots', () => {
    const all = [
      snap('old', 1, ['shared']),
      snap('new1', 2, ['shared', 'a']),
      snap('new2', 3, ['shared', 'b']),
    ];
    const plan = planRetention(all, new Set(), 2);
    expect(plan.dropSnapshots).toEqual(['old']);
    expect(plan.orphanBlobs).toEqual(new Set());
  });
});
