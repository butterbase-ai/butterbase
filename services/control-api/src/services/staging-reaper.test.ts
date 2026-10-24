import { describe, it, expect, vi, beforeEach } from 'vitest';
import { findIdleStagingApps, runOnce } from './staging-reaper.js';
import { onPauseStateChanged } from './app-pause.js';
let lockedRegion = 'test-region';
vi.mock('./app-state-lock.js', () => ({ withAppStateLocks: async (_pool: unknown, ids: string[], work: Function) =>
  work(ids.map(app_id=>({ app_id,region:lockedRegion })),{}) }));
const control = {} as never;
const sweep = (pool: never, days: number) => runOnce(pool,days,logger,control,'test-region');

function fakeDb(rows: { staging_app_id: string }[]) {
  const query = vi.fn()
    .mockResolvedValueOnce({ rows })
    .mockResolvedValue({ rowCount: rows.length, rows: rows.map((r) => ({ id: r.staging_app_id })) });
  return { pool: { query } as never, query };
}

const logger = { info: () => {}, warn: () => {}, error: () => {} };

beforeEach(() => { lockedRegion='test-region'; vi.clearAllMocks(); });

describe('staging reaper', () => {
  it('skips a candidate whose canonical home changed while waiting for its lock', async () => {
    lockedRegion='other-region';
    const { pool,query }=fakeDb([{ staging_app_id:'app_moved' }]);
    expect(await sweep(pool,30)).toEqual({ paused:0 });
    expect(query).toHaveBeenCalledTimes(1);
  });
  it('finds staging apps idle beyond the threshold', async () => {
    const { pool, query } = fakeDb([{ staging_app_id: 'app_a' }, { staging_app_id: 'app_b' }]);
    expect(await findIdleStagingApps(pool, 30)).toEqual(['app_a', 'app_b']);
    expect(query.mock.calls[0][1]).toEqual([30]);
  });

  it('pauses what it finds', async () => {
    const { pool } = fakeDb([{ staging_app_id: 'app_a' }]);
    expect(await sweep(pool, 30)).toEqual({ paused: 1 });
  });

  it('is a no-op when nothing is idle', async () => {
    const { pool, query } = fakeDb([]);
    expect(await sweep(pool, 30)).toEqual({ paused: 0 });
    expect(query).toHaveBeenCalledTimes(1); // no UPDATE issued
  });

  it('never touches a production app', async () => {
    const { pool, query } = fakeDb([{ staging_app_id: 'app_a' }]);
    await sweep(pool, 30);
    const update = query.mock.calls[1][0] as string;
    expect(update).toContain('app_environments');
    expect(update).toContain('staging_app_id');
  });

  it('labels the pause staging_reaper', async () => {
    const { pool, query } = fakeDb([{ staging_app_id: 'app_a' }]);
    await sweep(pool, 30);
    const update = query.mock.calls[1][0] as string;
    expect(update).toContain("paused_by = 'staging_reaper'");
    expect(update).toContain('RETURNING id');
  });

  it('never relabels an owner pause (WHERE paused = false)', async () => {
    const { pool, query } = fakeDb([{ staging_app_id: 'app_a' }]);
    await sweep(pool, 30);
    const update = query.mock.calls[1][0] as string;
    expect(update).toMatch(/WHERE[^]*paused = false/);
  });

  it('notifies pause listeners for each app actually paused', async () => {
    const seen: string[] = [];
    const off = onPauseStateChanged((c) => { seen.push(`${c.appId}:${c.by}`); });
    try {
      const { pool } = fakeDb([{ staging_app_id: 'app_a' }, { staging_app_id: 'app_b' }]);
      await sweep(pool, 30);
      expect(seen).toEqual(['app_a:staging_reaper', 'app_b:staging_reaper']);
    } finally {
      off();
    }
  });
});
