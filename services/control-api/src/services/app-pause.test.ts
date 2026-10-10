import { describe, it, expect, vi, afterEach } from 'vitest';
import { setPausedState, onPauseStateChanged, notifyPauseStateChanged } from './app-pause.js';

const row = (o: Record<string, unknown> = {}) => ({
  app_id: 'app_1', paused: true, paused_at: '2026-10-10T00:00:00Z',
  paused_reason: 'r', paused_by: 'owner', ...o,
});

function fakeDb(rows: unknown[]) {
  const query = vi.fn().mockResolvedValue({ rows });
  return { db: { query }, query };
}

const unsubs: Array<() => void> = [];
afterEach(() => { while (unsubs.length) unsubs.pop()!(); });

describe('setPausedState: pause', () => {
  it('writes paused_by and reason, keeps an existing paused_at', async () => {
    const { db, query } = fakeDb([row()]);
    const out = await setPausedState(db, 'app_1', { paused: true, by: 'owner', reason: 'r' });
    expect(out).toEqual(row());
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/paused_at = CASE WHEN paused THEN paused_at ELSE now\(\) END/);
    expect(sql).toMatch(/paused_by = \$3/);
    expect(sql).not.toMatch(/WHERE[^]*paused = false/); // re-pausing must update paused_by
    expect(params).toEqual(['app_1', 'r', 'owner']);
  });

  it('Review Focus #1: an owner pause over a reaper pause relabels it owner', async () => {
    const { db, query } = fakeDb([row({ paused_by: 'owner' })]);
    await setPausedState(db, 'app_1', { paused: true, by: 'owner' });
    expect(query.mock.calls[0][1]).toEqual(['app_1', null, 'owner']);
  });
});

describe('setPausedState: resume', () => {
  it('clears pause columns and refreshes activity', async () => {
    const { db, query } = fakeDb([row({ paused: false, paused_at: null, paused_reason: null, paused_by: null })]);
    await setPausedState(db, 'app_1', { paused: false, by: 'owner' });
    const sql = query.mock.calls[0][0] as string;
    for (const frag of ['paused = false', 'paused_at = NULL', 'paused_reason = NULL', 'paused_by = NULL', 'last_active_at = now()', 'idle_warned_at = NULL']) {
      expect(sql).toContain(frag);
    }
  });

  it('Review Focus #2: resuming a running app still succeeds and returns state', async () => {
    const { db } = fakeDb([row({ paused: false, paused_at: null, paused_reason: null, paused_by: null })]);
    const out = await setPausedState(db, 'app_1', { paused: false, by: 'owner' });
    expect(out?.paused).toBe(false);
  });

  it('returns null when the app row does not exist', async () => {
    const { db } = fakeDb([]);
    expect(await setPausedState(db, 'nope', { paused: false, by: 'owner' })).toBeNull();
  });
});

describe('listeners', () => {
  it('runs every listener after the write with the change', async () => {
    const seen: unknown[] = [];
    unsubs.push(onPauseStateChanged((c) => { seen.push(c); }));
    const { db } = fakeDb([row()]);
    await setPausedState(db, 'app_1', { paused: true, by: 'idle_reaper' });
    expect(seen).toEqual([{ appId: 'app_1', paused: true, by: 'idle_reaper' }]);
  });

  it('does not notify when the app row does not exist', async () => {
    const fn = vi.fn();
    unsubs.push(onPauseStateChanged(fn));
    await setPausedState(fakeDb([]).db, 'nope', { paused: true, by: 'owner' });
    expect(fn).not.toHaveBeenCalled();
  });

  it('Review Focus #3: a throwing or rejecting listener is logged, others still run, caller still succeeds', async () => {
    const log = { error: vi.fn() };
    const after = vi.fn();
    unsubs.push(onPauseStateChanged(() => { throw new Error('sync boom'); }));
    unsubs.push(onPauseStateChanged(async () => { throw new Error('async boom'); }));
    unsubs.push(onPauseStateChanged(after));
    const out = await setPausedState(fakeDb([row()]).db, 'app_1', { paused: true, by: 'owner' }, log);
    expect(out).not.toBeNull();
    expect(after).toHaveBeenCalledOnce();
    expect(log.error).toHaveBeenCalledTimes(2);
    expect(log.error.mock.calls[0][0]).toMatchObject({ appId: 'app_1' });
  });

  it('unsubscribe stops further calls', async () => {
    const fn = vi.fn();
    const off = onPauseStateChanged(fn);
    off();
    await notifyPauseStateChanged({ appId: 'a', paused: true, by: 'owner' });
    expect(fn).not.toHaveBeenCalled();
  });
});
