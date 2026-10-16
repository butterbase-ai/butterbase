import { describe, it, expect, vi, beforeEach } from 'vitest';

const setPausedState = vi.fn();
vi.mock('./app-pause.js', () => ({ setPausedState: (...a: unknown[]) => setPausedState(...a) }));
const pools: Record<string, { tag: string }> = { 'us-east-1': { tag: 'use1' }, 'us-west-2': { tag: 'usw2' } };
vi.mock('./runtime-db.js', () => ({ getRuntimeDbPool: vi.fn((_c: unknown, region: string) => pools[region]) }));
vi.mock('../config.js', () => ({ config: { runtimeDb: {} } }));

import { resumeIdlePausedAppsForOrg } from './idle-pause-upgrade.js';

const controlDb = { query: vi.fn() };
beforeEach(() => {
  setPausedState.mockReset();
  controlDb.query.mockReset().mockResolvedValue({
    rows: [{ app_id: 'a1', region: 'us-east-1' }, { app_id: 'a2', region: 'us-west-2' }],
  });
  delete process.env.BUTTERBASE_IDLE_PAUSE_PLANS;
});

describe('resumeIdlePausedAppsForOrg', () => {
  it('resumes only idle-reaper pauses, in each app’s home region', async () => {
    setPausedState.mockResolvedValueOnce({ app_id: 'a1' }).mockResolvedValueOnce(null);
    const r = await resumeIdlePausedAppsForOrg(controlDb, 'org_1', 'launch');
    expect(r).toEqual(['a1']);
    expect(controlDb.query.mock.calls[0][1]).toEqual(['org_1']);
    expect(setPausedState).toHaveBeenCalledWith(pools['us-east-1'], 'a1',
      { paused: false, by: 'system', onlyIfPausedBy: 'idle_reaper' }, undefined);
    expect(setPausedState).toHaveBeenCalledWith(pools['us-west-2'], 'a2',
      { paused: false, by: 'system', onlyIfPausedBy: 'idle_reaper' }, undefined);
  });

  it('skips idle-pause plans and a missing plan', async () => {
    expect(await resumeIdlePausedAppsForOrg(controlDb, 'org_1', 'playground')).toEqual([]);
    expect(await resumeIdlePausedAppsForOrg(controlDb, 'org_1', undefined)).toEqual([]);
    expect(await resumeIdlePausedAppsForOrg(controlDb, 'org_1', null)).toEqual([]);
    process.env.BUTTERBASE_IDLE_PAUSE_PLANS = 'playground,hobby';
    expect(await resumeIdlePausedAppsForOrg(controlDb, 'org_1', 'hobby')).toEqual([]);
    expect(controlDb.query).not.toHaveBeenCalled();
  });

  it('one failing app does not stop the rest, and nothing throws', async () => {
    const log = { error: vi.fn() };
    setPausedState.mockRejectedValueOnce(new Error('db down')).mockResolvedValueOnce({ app_id: 'a2' });
    expect(await resumeIdlePausedAppsForOrg(controlDb, 'org_1', 'launch', log)).toEqual(['a2']);
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ appId: 'a1', orgId: 'org_1' }), expect.any(String));
  });

  it('a control-DB failure is logged, not thrown', async () => {
    const log = { error: vi.fn() };
    controlDb.query.mockRejectedValueOnce(new Error('control down'));
    expect(await resumeIdlePausedAppsForOrg(controlDb, 'org_1', 'launch', log)).toEqual([]);
    expect(log.error).toHaveBeenCalledOnce();
  });
});
