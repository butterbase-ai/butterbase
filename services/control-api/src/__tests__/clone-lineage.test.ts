import { describe, it, expect, vi } from 'vitest';
import { recordLineage } from '../services/app-lineage.js';

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
