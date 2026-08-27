import { describe, it, expect, vi } from 'vitest';
import { recordLineage } from '../services/app-lineage.js';
import { decideLineageBase } from '../services/neon-task-worker.js';

describe('recordLineage', () => {
  it('stores base_fingerprint only when there is no base release', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await recordLineage({ query } as any, {
      destAppId: 'app_dst', destRegion: 'us-east-1',
      sourceAppId: 'app_src', sourceRegion: 'eu-west-1',
      baseReleaseId: null,
      baseFingerprint: { hashes: { schema: 'h', rls: 'h', functions: 'h', config: 'h' } } as any,
      baseSnapshotId: 'snap_1',
    });
    const params = query.mock.calls[0][1];
    expect(params[4]).toBeNull();               // base_release_id
    expect(JSON.parse(params[5]).hashes.schema).toBe('h');  // base_fingerprint
  });

  it('stores a pointer, not a duplicated manifest, when a release exists', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await recordLineage({ query } as any, {
      destAppId: 'app_dst2', destRegion: 'us-east-1',
      sourceAppId: 'app_src', sourceRegion: 'us-east-1',
      baseReleaseId: 'rel_9', baseFingerprint: null, baseSnapshotId: 'snap_1',
    });
    const params = query.mock.calls[0][1];
    expect(params[4]).toBe('rel_9');
    expect(params[5]).toBeNull();
  });

  it('is idempotent on retry', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await recordLineage({ query } as any, {
      destAppId: 'app_dst3', destRegion: 'us-east-1',
      sourceAppId: 'app_src', sourceRegion: 'us-east-1',
      baseReleaseId: null, baseFingerprint: null, baseSnapshotId: null,
    });
    expect(query.mock.calls[0][0]).toContain('ON CONFLICT (dest_app_id) DO NOTHING');
  });
});

// Covers executeClone's own lineage-wiring block (neon-task-worker.ts), which
// clone-lineage.test.ts above never touches — it only tests recordLineage in
// isolation. That gap is exactly why the FIX-1 bug (a pristine fork recorded
// against the wrong repo base) survived every per-task review: it lived in an
// untested expression three lines from an untested ternary.
//
// executeClone itself is not exercised end to end here — it provisions a real
// Neon DB, copies S3 blobs, and touches half a dozen pools, which makes it
// impractical to drive from a unit test. Instead the decision was extracted
// into decideLineageBase, a pure exported helper, and is tested directly; the
// second describe block below re-simulates the surrounding wiring (the
// baseFingerprint capture + the exact args handed to recordLineage) so the
// full clone-time decision — not just the ternary in isolation — has coverage.
describe('decideLineageBase', () => {
  it('adopts the latest release as the base when its snapshot matches what the clone replayed', () => {
    const latest = { id: 'rel_9', snapshot_id: 'snap_A' };
    const decision = decideLineageBase(latest, 'snap_A');
    expect(decision.baseRelease).toBe(latest);
    expect(decision.baseSnapshotId).toBe('snap_A');
  });

  it('rejects a stale release when the source repo has moved past it (the FIX-1 scenario)', () => {
    // Owner published release 3 at snap_A, then pushed further so HEAD is now
    // snap_B. The clone replays snap_B (job.source_snapshot_id), not snap_A.
    const latest = { id: 'rel_3', snapshot_id: 'snap_A' };
    const decision = decideLineageBase(latest, 'snap_B');
    expect(decision.baseRelease).toBeNull();
    expect(decision.baseSnapshotId).toBe('snap_B');
  });

  it('has no release to reject when none has ever been published', () => {
    const decision = decideLineageBase(null, 'snap_B');
    expect(decision.baseRelease).toBeNull();
    expect(decision.baseSnapshotId).toBe('snap_B');
  });

  it('baseSnapshotId is always job.source_snapshot_id, never the release snapshot', () => {
    // Even in the matching case, baseSnapshotId must come from the snapshot the
    // clone actually replayed, not from the release row — they happen to be
    // equal here, but the field's provenance is what setLatest() used, per FIX 1.
    const latest = { id: 'rel_9', snapshot_id: 'snap_A' };
    expect(decideLineageBase(latest, 'snap_A').baseSnapshotId).toBe('snap_A');
    expect(decideLineageBase(latest, 'snap_B').baseSnapshotId).toBe('snap_B');
  });
});

describe('executeClone lineage wiring (simulated: decideLineageBase + recordLineage args)', () => {
  // Re-creates the exact sequence executeClone runs after decideLineageBase,
  // so the assertion is on the real argument object passed to recordLineage —
  // not just on the pure helper's return value.
  async function runLineageStep(
    latestRelease: { id: string; snapshot_id: string } | null,
    sourceSnapshotId: string,
    captureAppStateStub: () => Promise<unknown>,
  ) {
    const { baseRelease, baseSnapshotId } = decideLineageBase(latestRelease, sourceSnapshotId);
    const baseFingerprint = baseRelease ? null : await captureAppStateStub();
    const args = {
      destAppId: 'app_dst', destRegion: 'us-east-1',
      sourceAppId: 'app_src', sourceRegion: 'us-east-1',
      baseReleaseId: baseRelease?.id ?? null,
      baseFingerprint,
      baseSnapshotId,
    };
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await recordLineage({ query } as any, args);
    return { args, query };
  }

  it('when the latest release matches the replayed snapshot: baseReleaseId set, baseFingerprint null, no capture performed', async () => {
    const captureAppStateStub = vi.fn().mockResolvedValue({ hashes: {} });
    const { args } = await runLineageStep(
      { id: 'rel_9', snapshot_id: 'snap_A' }, 'snap_A', captureAppStateStub,
    );
    expect(args.baseReleaseId).toBe('rel_9');
    expect(args.baseFingerprint).toBeNull();
    expect(args.baseSnapshotId).toBe('snap_A');
    expect(captureAppStateStub).not.toHaveBeenCalled();
  });

  it('when the latest release is stale (FIX-1 scenario): baseFingerprint captured, baseReleaseId null', async () => {
    const fingerprint = { hashes: { schema: 'h1', rls: 'h2', functions: 'h3', config: 'h4' } };
    const captureAppStateStub = vi.fn().mockResolvedValue(fingerprint);
    const { args } = await runLineageStep(
      { id: 'rel_3', snapshot_id: 'snap_A' }, 'snap_B', captureAppStateStub,
    );
    expect(args.baseReleaseId).toBeNull();
    expect(args.baseFingerprint).toBe(fingerprint);
    expect(args.baseSnapshotId).toBe('snap_B');
    expect(captureAppStateStub).toHaveBeenCalledOnce();
  });

  it('exactly one of baseReleaseId / baseFingerprint is populated in both branches, and baseSnapshotId always equals the replayed snapshot', async () => {
    const matching = await runLineageStep(
      { id: 'rel_9', snapshot_id: 'snap_A' }, 'snap_A', async () => ({ hashes: {} }),
    );
    expect(matching.args.baseReleaseId === null).toBe(false);
    expect(matching.args.baseFingerprint === null).toBe(true);
    expect(matching.args.baseSnapshotId).toBe('snap_A');

    const stale = await runLineageStep(
      { id: 'rel_3', snapshot_id: 'snap_A' }, 'snap_B', async () => ({ hashes: {} }),
    );
    expect(stale.args.baseReleaseId === null).toBe(true);
    expect(stale.args.baseFingerprint === null).toBe(false);
    expect(stale.args.baseSnapshotId).toBe('snap_B');

    const noRelease = await runLineageStep(
      null, 'snap_C', async () => ({ hashes: {} }),
    );
    expect(noRelease.args.baseReleaseId === null).toBe(true);
    expect(noRelease.args.baseFingerprint === null).toBe(false);
    expect(noRelease.args.baseSnapshotId).toBe('snap_C');
  });
});
