import { describe, it, expect, vi, beforeEach } from 'vitest';

const setPausedState = vi.fn();
vi.mock('./app-pause.js', () => ({ setPausedState: (...a: unknown[]) => setPausedState(...a), notifyPauseStateChanged: vi.fn(async () => {}) }));
const pools: Record<string, { tag: string }> = { 'us-east-1': { tag: 'use1' }, 'us-west-2': { tag: 'usw2' } };
vi.mock('./runtime-db.js', () => ({ getRuntimeDbPool: vi.fn((_c: unknown, region: string) => pools[region]) }));
vi.mock('../config.js', () => ({ config: { runtimeDb: {} } }));

import { resumeIdlePausedAppsForOrg } from './idle-pause-upgrade.js';

const controlDb = { query: vi.fn(), connect: vi.fn() };
beforeEach(() => {
  setPausedState.mockReset();
  controlDb.query.mockReset().mockImplementation(async (sql: string) => ({ rows: sql.includes('FROM organizations')
    ? [{ plan_id: 'launch' }]
    : [{ app_id: 'a1', region: 'us-east-1', organization_id:'org_1' }, { app_id: 'a2', region: 'us-west-2', organization_id:'org_1' }],
  }));
  controlDb.connect.mockReset().mockResolvedValue({ query: controlDb.query, release: vi.fn() });
  delete process.env.BUTTERBASE_IDLE_PAUSE_PLANS;
});

describe('resumeIdlePausedAppsForOrg', () => {
  it('sets the timeout before waiting on the organization lock', async () => {
    await resumeIdlePausedAppsForOrg(controlDb,'org_1','launch');
    const sql=controlDb.query.mock.calls.map(([query])=>query as string);
    expect(sql.indexOf("SET LOCAL lock_timeout = '5s'")).toBeLessThan(sql.findIndex(query=>query.includes('FOR SHARE')));
  });
  it('retries a transient app-lock timeout instead of dropping the billing resume', async () => {
    const original=controlDb.query.getMockImplementation()!;
    let timedOut=false;
    controlDb.query.mockImplementation(async (sql:string)=>{
      if(sql.includes('FOR UPDATE')&&!timedOut){timedOut=true;throw Object.assign(new Error('lock timeout'),{code:'55P03'});}
      return original(sql);
    });
    setPausedState.mockResolvedValue({app_id:'a1'});
    await resumeIdlePausedAppsForOrg(controlDb,'org_1','launch');
    expect(controlDb.connect).toHaveBeenCalledTimes(2);
    expect(setPausedState).toHaveBeenCalled();
  });
  it('resolves the home again under the app lock after an intervening cutover', async () => {
    const original = controlDb.query.getMockImplementation()!;
    controlDb.query.mockImplementation(async (sql: string) => sql.includes('FOR UPDATE')
      ? { rows:[{ app_id:'a1',region:'us-west-2',organization_id:'org_1' }] }
      : original(sql));
    setPausedState.mockResolvedValue({ app_id:'a1' });
    await resumeIdlePausedAppsForOrg(controlDb,'org_1','launch');
    expect(setPausedState).toHaveBeenCalledWith(pools['us-west-2'],'a1',expect.anything(),undefined,{ notify:false });
    expect(setPausedState).not.toHaveBeenCalledWith(pools['us-east-1'],expect.anything(),expect.anything(),expect.anything(),expect.anything());
  });
  it('ignores a stale paid upgrade after the org has already downgraded', async () => {
    controlDb.query.mockImplementation(async () => ({ rows: [{ plan_id: 'playground', app_id: 'a1', region: 'us-east-1' }] }));
    expect(await resumeIdlePausedAppsForOrg(controlDb, 'org_1', 'launch')).toEqual([]);
    expect(setPausedState).not.toHaveBeenCalled();
  });
  it('resumes only idle-reaper pauses, in each app’s home region', async () => {
    setPausedState.mockResolvedValueOnce({ app_id: 'a1' }).mockResolvedValueOnce(null);
    const r = await resumeIdlePausedAppsForOrg(controlDb, 'org_1', 'launch');
    expect(r).toEqual(['a1']);
    expect(controlDb.query).toHaveBeenCalledWith(expect.stringContaining('FROM org_app_index'), ['org_1']);
    expect(setPausedState).toHaveBeenCalledWith(pools['us-east-1'], 'a1',
      { paused: false, by: 'system', onlyIfPausedBy: 'idle_reaper' }, undefined, { notify: false });
    expect(setPausedState).toHaveBeenCalledWith(pools['us-west-2'], 'a2',
      { paused: false, by: 'system', onlyIfPausedBy: 'idle_reaper' }, undefined, { notify: false });
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
