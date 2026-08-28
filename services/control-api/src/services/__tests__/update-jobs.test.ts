import { describe, it, expect } from 'vitest';
import type pg from 'pg';
import { createUpdateJob, getActiveUpdateJob } from '../clone-jobs.js';

function fakeDb(rows: unknown[] = []) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const db = {
    query: async (sql: string, params: unknown[] = []) => { calls.push({ sql, params }); return { rows }; },
  } as unknown as pg.Pool;
  return { db, calls };
}

describe('createUpdateJob', () => {
  it('writes mode=update with the fork as dest_app_id', async () => {
    const { db, calls } = fakeDb([{ id: 'cj_1', mode: 'update' }]);
    await createUpdateJob(db, {
      forkAppId: 'app_fork', forkRegion: 'us-east-1',
      sourceAppId: 'app_src', sourceRegion: 'us-east-1',
      targetReleaseId: 'rel_1', sourceSnapshotId: 'snap_1',
      requestedByUserId: 'usr_1', preSyncSnapshotId: 'snap_prev',
    });
    const insert = calls.find((c) => c.sql.includes('INSERT INTO template_clone_jobs'));
    expect(insert).toBeDefined();
    expect(insert!.params).toContain('update');
    expect(insert!.params).toContain('app_fork');
    expect(insert!.params).toContain('rel_1');
    expect(insert!.params).toContain('snap_prev');
  });

  it('rejects a missing forkAppId rather than writing a NULL dest_app_id', async () => {
    const { db } = fakeDb([]);
    await expect(createUpdateJob(db, {
      forkAppId: '', forkRegion: 'us-east-1',
      sourceAppId: 'app_src', sourceRegion: 'us-east-1',
      targetReleaseId: 'rel_1', sourceSnapshotId: 'snap_1',
      requestedByUserId: 'usr_1', preSyncSnapshotId: null,
    })).rejects.toThrow();
  });
});

describe('getActiveUpdateJob', () => {
  it('queries only non-terminal update rows for that fork', async () => {
    const { db, calls } = fakeDb([]);
    await getActiveUpdateJob(db, 'app_fork');
    const sql = calls[0].sql;
    expect(sql).toMatch(/mode\s*=\s*'update'/);
    expect(sql).toMatch(/status IN \('pending', 'processing'\)/);
    expect(calls[0].params).toContain('app_fork');
  });
});
