import { afterEach, expect, it, vi } from 'vitest';
import { reconcileIdlePausedUpgrades, startIdlePauseUpgradeReconciler } from './idle-pause-upgrade-reconciler.js';
const resume=vi.hoisted(()=>vi.fn());
vi.mock('./idle-pause-upgrade.js',()=>({resumeIdlePausedAppsForOrg:resume}));
afterEach(()=>{vi.useRealTimers();vi.clearAllMocks();});
it('revisits persisted paid organizations in bounded pages, so missed hooks are recoverable after restart',async()=>{
  const db={query:vi.fn().mockResolvedValue({rows:[{id:'org_a',plan_id:'launch'},{id:'org_b',plan_id:'scale'}]}),connect:vi.fn()};
  const cursor=await reconcileIdlePausedUpgrades(db,undefined,undefined,2);
  expect(cursor).toBe('org_b');
  expect(db.query).toHaveBeenCalledWith(expect.stringContaining('organizations'),[null,['playground'],2]);
  expect(resume).toHaveBeenCalledWith(db,'org_a','launch',undefined);
  expect(resume).toHaveBeenCalledWith(db,'org_b','scale',undefined);
  db.query.mockResolvedValueOnce({rows:[]});
  expect(await reconcileIdlePausedUpgrades(db,cursor,undefined,2)).toBeUndefined();
  expect(db.query).toHaveBeenLastCalledWith(expect.stringContaining('o.id >'),['org_b',['playground'],2]);
});
it('starts recovery even with automatic idle pausing disabled and drains on close',async()=>{
  vi.useFakeTimers();vi.stubEnv('BUTTERBASE_IDLE_PAUSE_DAYS','');
  let release!:()=>void;
  const db={query:vi.fn().mockImplementationOnce(()=>new Promise(resolve=>{release=()=>resolve({rows:[]});})).mockResolvedValue({rows:[]}),connect:vi.fn()};
  const stop=startIdlePauseUpgradeReconciler(db,{error:vi.fn()},100);
  expect(db.query).toHaveBeenCalledOnce();
  const closed=vi.fn();const closing=stop().then(closed);
  await Promise.resolve();expect(closed).not.toHaveBeenCalled();
  release();await closing;
  await vi.advanceTimersByTimeAsync(1000);expect(db.query).toHaveBeenCalledOnce();
  vi.unstubAllEnvs();
});
it('retries a failed discovery on the next tick without overlapping runs',async()=>{
  vi.useFakeTimers();const log={error:vi.fn()};
  const db={query:vi.fn().mockRejectedValueOnce(new Error('db down')).mockResolvedValue({rows:[]}),connect:vi.fn()};
  const stop=startIdlePauseUpgradeReconciler(db,log,100);
  await vi.advanceTimersByTimeAsync(100);
  expect(log.error).toHaveBeenCalledOnce();expect(db.query).toHaveBeenCalledTimes(2);
  await stop();
});
it('drains subsequent pages in the same scan instead of sleeping between them',async()=>{
  vi.useFakeTimers();
  const rows=Array.from({length:25},(_,i)=>({id:`org_${i}`,plan_id:'launch'}));
  const db={query:vi.fn().mockResolvedValueOnce({rows}).mockResolvedValue({rows:[]}),connect:vi.fn()};
  const stop=startIdlePauseUpgradeReconciler(db,{error:vi.fn()},100);
  await vi.advanceTimersByTimeAsync(0);
  expect(db.query).toHaveBeenCalledTimes(2);
  await stop();
});
it('finishes the current organization on shutdown without starting the rest of the page',async()=>{
  let release!:()=>void;
  resume.mockImplementationOnce(()=>new Promise(resolve=>{release=()=>resolve([]);}));
  const db={query:vi.fn().mockResolvedValue({rows:[{id:'org_a',plan_id:'launch'},{id:'org_b',plan_id:'launch'}]}),connect:vi.fn()};
  const stop=startIdlePauseUpgradeReconciler(db,{error:vi.fn()});
  await Promise.resolve();expect(resume).toHaveBeenCalledOnce();
  const closing=stop();release();await closing;
  expect(resume).toHaveBeenCalledOnce();
});
