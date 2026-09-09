import { describe, it, expect, vi } from 'vitest';
import { teardownAppStorage } from './app-storage-teardown.js';

/**
 * A tiny fake Pool. `objects` is the whole `storage_objects` table; the two
 * queries this module runs are matched by their leading keyword so the test
 * exercises the real SQL shape rather than a stub per call site.
 */
function fakePool(objects: { app_id: string; bucket: string; key: string }[], opts?: {
  failListing?: boolean; failShareCheck?: boolean;
}) {
  return {
    query: vi.fn(async (sql: string, params: any[]) => {
      if (sql.includes('SELECT bucket, key FROM storage_objects')) {
        if (opts?.failListing) throw new Error('runtime db down');
        return { rows: objects.filter((o) => o.app_id === params[0]).map((o) => ({ bucket: o.bucket, key: o.key })) };
      }
      if (opts?.failShareCheck) throw new Error('runtime db down');
      const [bucket, key, appId] = params;
      return {
        rows: objects
          .filter((o) => o.bucket === bucket && o.key === key && o.app_id !== appId)
          .slice(0, 1)
          .map(() => ({ one: 1 })),
      };
    }),
  } as any;
}

describe('teardownAppStorage', () => {
  it('deletes every key the app owns exclusively', async () => {
    const pool = fakePool([
      { app_id: 'app_stg', bucket: 'b', key: 'app_stg/u1/aaa_photo.png' },
      { app_id: 'app_stg', bucket: 'b', key: 'app_stg/u1/bbb_notes.txt' },
    ]);
    const deleteObject = vi.fn(async () => {});

    const res = await teardownAppStorage({ runtimeDb: pool, appId: 'app_stg', deleteObject });

    expect(res).toEqual({ deleted: 2, shared: 0, failed: 0, total: 2 });
    expect(deleteObject).toHaveBeenCalledTimes(2);
    expect(deleteObject.mock.calls.map((c) => c[0])).toEqual([
      'app_stg/u1/aaa_photo.png', 'app_stg/u1/bbb_notes.txt',
    ]);
  });

  /**
   * The whole reason this module is not a two-line loop. `rewriteObjectKey`
   * returns an unrecognised key verbatim, so a staging row can point at
   * production's key. Deleting the staging app must not take production's only
   * copy of those bytes with it.
   */
  it('refuses to delete a key another app still references', async () => {
    const shared = { bucket: 'b', key: 'legacy-layout-object' };
    const pool = fakePool([
      { app_id: 'app_stg', ...shared },
      { app_id: 'app_prod', ...shared },
      { app_id: 'app_stg', bucket: 'b', key: 'app_stg/u1/ccc_own.png' },
    ]);
    const deleteObject = vi.fn(async () => {});

    const res = await teardownAppStorage({ runtimeDb: pool, appId: 'app_stg', deleteObject });

    expect(res).toEqual({ deleted: 1, shared: 1, failed: 0, total: 2 });
    expect(deleteObject).toHaveBeenCalledTimes(1);
    expect(deleteObject).toHaveBeenCalledWith('app_stg/u1/ccc_own.png');
  });

  it('counts a failed delete and keeps going, never throwing', async () => {
    const pool = fakePool([
      { app_id: 'app_stg', bucket: 'b', key: 'app_stg/u1/aaa.png' },
      { app_id: 'app_stg', bucket: 'b', key: 'app_stg/u1/bbb.png' },
    ]);
    const deleteObject = vi.fn()
      .mockRejectedValueOnce(new Error('S3 down'))
      .mockResolvedValueOnce(undefined);

    const res = await teardownAppStorage({ runtimeDb: pool, appId: 'app_stg', deleteObject });

    expect(res).toEqual({ deleted: 1, shared: 0, failed: 1, total: 2 });
  });

  it('deletes nothing when the share check cannot be answered', async () => {
    const pool = fakePool(
      [{ app_id: 'app_stg', bucket: 'b', key: 'app_stg/u1/aaa.png' }],
      { failShareCheck: true },
    );
    const deleteObject = vi.fn(async () => {});

    const res = await teardownAppStorage({ runtimeDb: pool, appId: 'app_stg', deleteObject });

    expect(res).toEqual({ deleted: 0, shared: 0, failed: 1, total: 1 });
    expect(deleteObject).not.toHaveBeenCalled();
  });

  it('is a no-op for an app with no objects', async () => {
    const pool = fakePool([{ app_id: 'other', bucket: 'b', key: 'other/u/x.png' }]);
    const deleteObject = vi.fn(async () => {});

    const res = await teardownAppStorage({ runtimeDb: pool, appId: 'app_stg', deleteObject });

    expect(res).toEqual({ deleted: 0, shared: 0, failed: 0, total: 0 });
    expect(deleteObject).not.toHaveBeenCalled();
  });

  it('returns an empty result rather than throwing when the listing query fails', async () => {
    const pool = fakePool([], { failListing: true });
    const deleteObject = vi.fn(async () => {});

    const res = await teardownAppStorage({ runtimeDb: pool, appId: 'app_stg', deleteObject });

    expect(res).toEqual({ deleted: 0, shared: 0, failed: 0, total: 0 });
    expect(deleteObject).not.toHaveBeenCalled();
  });
});
