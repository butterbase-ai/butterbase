import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
import pg from 'pg';
import Fastify from 'fastify';
const routing = vi.hoisted(()=>({ pools:{} as Record<string,pg.Pool> }));
vi.mock('../config.js',()=>({ config:{ runtimeDb:{},dashboardUrl:'http://localhost:3000' } }));
vi.mock('./runtime-db.js',()=>({ getRuntimeDbPool:(_cfg:unknown,region:string)=>routing.pools[region] }));
vi.mock('./region-resolver.js',()=>({ resolveAppHomeRegion:async ()=>'a' }));
vi.mock('./redis-registry.js',()=>({ redisFor:()=>({ set:async ()=>'OK',del:async ()=>1 }) }));
vi.mock('./app-resolver.js',async orig=>({ ...(await orig<object>()),AppResolver:{ resolveApp:async (_db:unknown,id:string)=>({ id }) } }));
vi.mock('./audit/with-audit.js',()=>({ logFromRequest:vi.fn() }));
vi.mock('./app-plan-resolver.js',()=>({ getLimitsForApp:vi.fn() }));
import { withAppStateLocks } from './app-state-lock.js';
import { cutoverAppState } from './move-app/cutover-app-state.js';
import { appConfigRoutes } from '../routes/app-config.js';
import { resumeIdlePausedAppsForOrg } from './idle-pause-upgrade.js';
import { reconcileIdlePausedUpgrades } from './idle-pause-upgrade-reconciler.js';
import { markAppActive } from './app-activity.js';
import { runOnce as sweepStaging } from './staging-reaper.js';
import { onPauseStateChanged } from './app-pause.js';

const url = process.env.IDLE_PAUSE_TEST_DATABASE_URL;
describe.skipIf(!url)('app state locking and cutover (real Postgres)', () => {
  const suffix = randomUUID().replaceAll('-','');
  const schemas = [`lock_control_${suffix}`,`lock_a_${suffix}`,`lock_b_${suffix}`];
  let admin: pg.Pool, control: pg.Pool, a: pg.Pool, b: pg.Pool;
  const org='11111111-1111-1111-1111-111111111111';
  const log={ info:vi.fn(),warn:vi.fn(),error:vi.fn() };
  const ctx = () => ({ controlPool: control, runtimePoolFor: (r: string) => r === 'a' ? a : b });
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url });
    for (const s of schemas) await admin.query(`CREATE SCHEMA ${s}`);
    [control,a,b] = schemas.map(s=>new pg.Pool({ connectionString: url, options: `-c search_path=${s}` }));
    await control.query('CREATE TABLE org_app_index(app_id text PRIMARY KEY,region text,organization_id uuid,updated_at timestamptz DEFAULT now())');
    await control.query(`CREATE TABLE organizations(id uuid PRIMARY KEY,plan_id text); INSERT INTO organizations VALUES ('${org}','playground')`);
    for (const pool of [a,b]) await pool.query(`CREATE TABLE apps(id text PRIMARY KEY,paused boolean,paused_at timestamptz,paused_reason text,paused_by text,
      last_active_at timestamptz,idle_warned_at timestamptz,idle_pause_notified_at timestamptz,region text,
      provisioning_status text DEFAULT 'migrating',db_provisioned boolean DEFAULT false,updated_at timestamptz DEFAULT now());
      CREATE TABLE app_environments(staging_app_id text,created_at timestamptz,last_reset_at timestamptz)`);
    routing.pools={a,b};
  });
  beforeEach(async () => {
    await control.query(`TRUNCATE org_app_index; INSERT INTO org_app_index(app_id,region,organization_id) VALUES ('app_lock','a','${org}'); UPDATE organizations SET plan_id='playground'`);
    for (const pool of [a,b]) await pool.query("TRUNCATE apps,app_environments; INSERT INTO apps(id,paused,last_active_at) VALUES ('app_lock',false,now()-interval '40 days')");
  });
  afterAll(async () => {
    await Promise.all([control?.end(),a?.end(),b?.end()]);
    if (admin) { for(const s of schemas) await admin.query(`DROP SCHEMA ${s} CASCADE`); await admin.end(); }
  });
  const home = async () => (await control.query("SELECT region FROM org_app_index WHERE app_id='app_lock'")).rows[0].region;
  function delayedCutover() {
    let release!:()=>void,entered!:()=>void;
    const gate=new Promise<void>(r=>{release=r;}),ready=new Promise<void>(r=>{entered=r;});
    const dest={ query:async (...args:any[])=>{
      if(String(args[0]).includes('SET paused = $2')) { entered(); await gate; }
      return (b.query.bind(b) as any)(...args);
    } };
    const pending=cutoverAppState({ ...ctx(),runtimePoolFor:r=>r==='a'?a:dest as never },'app_lock','a','b');
    return {pending,ready,release:()=>release()};
  }
  it('actual owner PATCH waits through cutover and writes the new region',async()=>{
    const app=Fastify(); app.decorate('controlDb',control); app.decorateRequest('auth',null as never);
    let requested!:()=>void; const entered=new Promise<void>(r=>{requested=r;});
    app.addHook('onRequest',async req=>{req.auth={ userId:org,organizationId:org,authMethod:'api_key',scopes:['*'] };requested();});
    await app.register(appConfigRoutes); await app.ready();
    const move=delayedCutover(); await move.ready;
    const request=app.inject({ method:'PATCH',url:'/v1/app_lock/config/pause',payload:{paused:true} }).then(r=>r);
    try {
      await entered; move.release(); await move.pending;
      expect((await request).statusCode).toBe(200);
      expect((await b.query('SELECT paused FROM apps')).rows[0].paused).toBe(true);
      expect((await a.query('SELECT paused FROM apps')).rows[0].paused).toBe(false);
    } finally {move.release();await move.pending;await app.close();}
  });
  it('publishes an owner runtime write after control COMMIT failure and lock release',async()=>{
    const badControl={connect:async()=>{
      const client=await control.connect();
      return {query:async(...args:any[])=>{
        if(args[0]==='COMMIT')throw new Error('commit failed');
        return (client.query.bind(client) as any)(...args);
      },release:()=>client.release()};
    }};
    const app=Fastify();app.decorate('controlDb',badControl as never);app.decorateRequest('auth',null as never);
    app.addHook('onRequest',async req=>{req.auth={userId:org,authMethod:'api_key',scopes:['*']};});
    await app.register(appConfigRoutes);await app.ready();
    let published=false;
    const off=onPauseStateChanged(async change=>{
      if(change.appId!=='app_lock')return;
      await control.query('SELECT app_id FROM org_app_index FOR UPDATE NOWAIT');published=true;
    });
    try{
      const result=await app.inject({method:'PATCH',url:'/v1/app_lock/config/pause',payload:{paused:true}});
      expect(result.statusCode).toBe(500);
      expect((await a.query('SELECT paused FROM apps')).rows[0].paused).toBe(true);
      expect(published).toBe(true);
    }finally{off();await app.close();}
  });
  it('returns a retryable 409 with no write when an owner cannot acquire the app lock',async()=>{
    const holder=await control.connect();await holder.query('BEGIN');
    await holder.query('SELECT app_id FROM org_app_index FOR UPDATE');
    const app=Fastify();app.decorate('controlDb',control);app.decorateRequest('auth',null as never);
    app.addHook('onRequest',async req=>{req.auth={userId:org,authMethod:'api_key',scopes:['*']};});
    await app.register(appConfigRoutes);await app.ready();
    try{
      const result=await app.inject({method:'PATCH',url:'/v1/app_lock/config/pause',payload:{paused:true}});
      expect(result.statusCode).toBe(409);expect(result.json().error.code).toBe('APP_STATE_BUSY');
      expect((await a.query('SELECT paused FROM apps')).rows[0].paused).toBe(false);
    }finally{await holder.query('ROLLBACK');holder.release();await app.close();}
  });
  it('recovers an exhausted billing hook from persisted plans after a cutover',async()=>{
    await control.query("UPDATE organizations SET plan_id='launch'");
    await a.query("UPDATE apps SET paused=true,paused_by='idle_reaper'");
    const busy={connect:async()=>{
      const client=await control.connect();
      return {query:async(...args:any[])=>{
        if(String(args[0]).includes('FOR UPDATE'))throw Object.assign(new Error('busy'),{code:'55P03'});
        return (client.query.bind(client) as any)(...args);
      },release:()=>client.release()};
    },query:control.query.bind(control)};
    expect(await resumeIdlePausedAppsForOrg(busy as never,org,'launch',log)).toEqual([]);
    expect((await a.query('SELECT paused FROM apps')).rows[0].paused).toBe(true);
    await cutoverAppState(ctx(),'app_lock','a','b');
    await reconcileIdlePausedUpgrades(control,undefined,log);
    expect((await b.query('SELECT paused FROM apps')).rows[0].paused).toBe(false);
    expect((await a.query('SELECT paused FROM apps')).rows[0].paused).toBe(true);
  });
  it('actual billing resume queued behind cutover follows its new home',async()=>{
    await a.query("UPDATE apps SET paused=true,paused_by='idle_reaper'");
    await control.query("UPDATE organizations SET plan_id='launch'");
    const move=delayedCutover(); await move.ready;
    const resume=resumeIdlePausedAppsForOrg(control,org,'launch',log);
    try {
      await vi.waitFor(async()=>{
        await expect(control.query('SELECT id FROM organizations FOR UPDATE NOWAIT')).rejects.toMatchObject({code:'55P03'});
      });
      move.release();await move.pending;
      expect(await resume).toEqual(['app_lock']);
      expect((await b.query('SELECT paused FROM apps')).rows[0].paused).toBe(false);
      expect((await a.query('SELECT paused FROM apps')).rows[0].paused).toBe(true);
    } finally {move.release();await move.pending;await resume;}
  });
  it('activity queued behind cutover ignores a stale region cache',async()=>{
    const move=delayedCutover();await move.ready;
    const activity=markAppActive(control,'app_lock',log);
    try {
      move.release();await move.pending;await activity;
      expect(Date.now()-(await b.query('SELECT last_active_at FROM apps')).rows[0].last_active_at.getTime()).toBeLessThan(5000);
      expect(Date.now()-(await a.query('SELECT last_active_at FROM apps')).rows[0].last_active_at.getTime()).toBeGreaterThan(39*86400000);
    } finally {move.release();await move.pending;await activity;}
  });
  it('actual staging reaper skips an idle row left in the retired region',async()=>{
    await a.query("UPDATE apps SET updated_at=now()-interval '40 days'; INSERT INTO app_environments VALUES ('app_lock',now()-interval '40 days',null)");
    await cutoverAppState(ctx(),'app_lock','a','b');
    expect(await sweepStaging(a,30,log,control,'a')).toEqual({paused:0});
    expect((await a.query('SELECT paused FROM apps')).rows[0].paused).toBe(false);
  });
  it('locks before resolving home; a queued writer follows the committed new region', async () => {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(r=>{ release=r; }), ready = new Promise<void>(r=>{ entered=r; });
    const first = withAppStateLocks(control,['app_lock'],async (_refs,client) => {
      entered(); await gate;
      await client.query("UPDATE org_app_index SET region='b' WHERE app_id='app_lock'");
    });
    await ready;
    try {
      await expect(control.query("SELECT app_id FROM org_app_index WHERE app_id='app_lock' FOR UPDATE NOWAIT")).rejects.toMatchObject({ code: '55P03' });
      const waiting = withAppStateLocks(control,['app_lock'],async refs => refs[0].region);
      release(); await first;
      expect(await waiting).toBe('b');
      await expect(control.query("SELECT app_id FROM org_app_index WHERE app_id='app_lock' FOR UPDATE NOWAIT")).resolves.toBeDefined();
    } finally { release(); await first; }
  });
  it('copies the current pause/activity state before publishing the new home', async () => {
    await a.query("UPDATE apps SET paused=true,paused_at=now(),paused_by='idle_reaper',paused_reason='idle',idle_warned_at=now(),idle_pause_notified_at=now()");
    await cutoverAppState(ctx(),'app_lock','a','b');
    expect(await home()).toBe('b');
    const copied = (await b.query("SELECT * FROM apps WHERE id='app_lock'")).rows[0];
    expect(copied).toMatchObject({ paused:true,paused_by:'idle_reaper',paused_reason:'idle',region:'b',provisioning_status:'ready',db_provisioned:true });
    expect(copied.idle_warned_at).toBeInstanceOf(Date);
    expect(copied.last_active_at).toEqual((await a.query('SELECT last_active_at FROM apps')).rows[0].last_active_at);
  });
  it('retry after committed cutover preserves writes already made at the new home', async () => {
    await cutoverAppState(ctx(),'app_lock','a','b');
    await b.query("UPDATE apps SET paused=true,paused_by='owner',last_active_at=now()");
    const before = (await b.query('SELECT * FROM apps')).rows;
    await cutoverAppState(ctx(),'app_lock','a','b');
    expect((await b.query('SELECT * FROM apps')).rows).toEqual(before);
  });
  it('missing destination never changes the authoritative home', async () => {
    await b.query('DELETE FROM apps');
    await expect(cutoverAppState(ctx(),'app_lock','a','b')).rejects.toThrow();
    expect(await home()).toBe('a');
    await expect(control.query("SELECT app_id FROM org_app_index FOR UPDATE NOWAIT")).resolves.toBeDefined();
  });
  it('failed control commit leaves old routing and can safely retry from fresh source state', async () => {
    const badControl = { connect: async () => {
      const c = await control.connect();
      return { query: async (...args: unknown[]) => {
        if(args[0] === 'COMMIT') throw new Error('commit failed');
        return (c.query.bind(c) as (...a: unknown[])=>Promise<unknown>)(...args);
      }, release: () => c.release() };
    } };
    await expect(cutoverAppState({ ...ctx(),controlPool:badControl as never },'app_lock','a','b')).rejects.toThrow('commit failed');
    expect(await home()).toBe('a');
    await a.query("UPDATE apps SET paused=true,paused_by='owner'");
    await cutoverAppState(ctx(),'app_lock','a','b');
    expect((await b.query('SELECT paused FROM apps')).rows[0].paused).toBe(true);
  });
  it('a failed callback rolls back routing and releases its lock', async () => {
    await expect(withAppStateLocks(control,['app_lock'],async (_refs,client) => {
      await client.query("UPDATE org_app_index SET region='b'"); throw new Error('work failed');
    })).rejects.toThrow('work failed');
    expect(await home()).toBe('a');
    await expect(withAppStateLocks(control,['app_lock'],async refs=>refs[0].region)).resolves.toBe('a');
  });
});
