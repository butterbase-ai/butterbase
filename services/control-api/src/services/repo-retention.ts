import { REPO_RETAIN_SNAPSHOTS } from './repo-manifest.js';

export interface SnapshotSummary {
  snapshotId: string;
  createdAt: Date;
  blobs: Set<string>;
}

export interface RetentionPlan {
  retainSnapshots: string[];
  dropSnapshots: string[];
  orphanBlobs: Set<string>;
}

/**
 * Given all snapshots and the always-pinned ids (e.g. latest, future: clone-pinned),
 * decide what to drop. Keeps the most recent N + everything pinned.
 */
export function planRetention(
  all: SnapshotSummary[],
  pinned: Set<string>,
  retain: number = REPO_RETAIN_SNAPSHOTS,
): RetentionPlan {
  const byRecent = [...all].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const keepSet = new Set<string>();
  let recentSlots = retain;
  for (const s of byRecent) {
    if (pinned.has(s.snapshotId)) {
      keepSet.add(s.snapshotId);
      continue;
    }
    if (recentSlots > 0) {
      keepSet.add(s.snapshotId);
      recentSlots--;
    }
  }
  const retainSnapshots = [...keepSet];
  const dropSnapshots = all.filter(s => !keepSet.has(s.snapshotId)).map(s => s.snapshotId);

  const stillReferenced = new Set<string>();
  for (const s of all) if (keepSet.has(s.snapshotId)) for (const b of s.blobs) stillReferenced.add(b);
  const orphanBlobs = new Set<string>();
  for (const s of all) if (!keepSet.has(s.snapshotId)) {
    for (const b of s.blobs) if (!stillReferenced.has(b)) orphanBlobs.add(b);
  }
  return { retainSnapshots, dropSnapshots, orphanBlobs };
}
