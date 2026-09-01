import { describe, it, expect } from 'vitest';
import type pg from 'pg';
import { listActiveCloneSnapshotIdsForApp } from '../services/clone-jobs.js';
import { listReleaseSnapshotIdsForApp } from '../services/template-releases.js';

/** Captures the SQL + params a helper issues, and replays canned rows. */
function fakeDb(rows: Record<string, unknown>[]) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return { rows, rowCount: rows.length };
    },
  } as unknown as pg.Pool;
  return { pool, calls };
}

// A published release pins its snapshot forever. repo push runs planRetention
// with REPO_RETAIN_SNAPSHOTS = 5, and the pinned set only ever held the newest
// snapshot plus in-flight clones — so pushing five commits after publishing a
// release deleted the snapshot that release points at, along with its orphan
// blobs. The release row survived, pointing at bytes that no longer existed,
// and every fork updating from it failed with "Source manifest not found".
describe('listReleaseSnapshotIdsForApp', () => {
  it('returns every published release snapshot for the app', async () => {
    const { pool } = fakeDb([{ snapshot_id: 'snap_r1' }, { snapshot_id: 'snap_r2' }]);
    const ids = await listReleaseSnapshotIdsForApp(pool, 'app_tmpl');
    expect(ids).toEqual(new Set(['snap_r1', 'snap_r2']));
  });

  it('scopes the query to the app and reads template_releases', async () => {
    const { pool, calls } = fakeDb([]);
    await listReleaseSnapshotIdsForApp(pool, 'app_tmpl');
    expect(calls[0].sql).toMatch(/FROM template_releases/i);
    expect(calls[0].params).toEqual(['app_tmpl']);
  });

  it('returns an empty set for a template with no releases', async () => {
    const { pool } = fakeDb([]);
    expect(await listReleaseSnapshotIdsForApp(pool, 'app_tmpl')).toEqual(new Set());
  });

  // Two releases can be published from the same snapshot (publish twice with no
  // push between). A Set already dedupes; this documents that it must.
  it('dedupes releases that share a snapshot', async () => {
    const { pool } = fakeDb([{ snapshot_id: 'snap_r1' }, { snapshot_id: 'snap_r1' }]);
    expect(await listReleaseSnapshotIdsForApp(pool, 'app_tmpl')).toEqual(new Set(['snap_r1']));
  });
});

// Same predicate bug that migration 111 fixed for the update mutex: a clone
// passes through copying_repo / replaying_schema / replaying_rls /
// replaying_functions / seeding_data / replaying_config /
// replaying_durable_objects, but the pin only covered pending + processing. From
// copying_repo onward the source snapshot was unpinned, so a repo push on the
// template mid-clone could delete the very snapshot being copied.
describe('listActiveCloneSnapshotIdsForApp', () => {
  it('pins on every NON-TERMINAL status, not just pending/processing', async () => {
    const { pool, calls } = fakeDb([]);
    await listActiveCloneSnapshotIdsForApp(pool, 'app_tmpl');
    const sql = calls[0].sql;
    expect(sql).not.toMatch(/IN \(\s*'pending',\s*'processing'\s*\)/i);
    expect(sql).toMatch(/NOT/i);
    expect(calls[0].params).toEqual(['app_tmpl', ['completed', 'failed']]);
  });

  it('returns the snapshots in-flight clones are reading', async () => {
    const { pool } = fakeDb([{ source_snapshot_id: 'snap_a' }, { source_snapshot_id: 'snap_b' }]);
    expect(await listActiveCloneSnapshotIdsForApp(pool, 'app_tmpl'))
      .toEqual(new Set(['snap_a', 'snap_b']));
  });
});
