import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { Redis } from 'ioredis';

const emails = vi.hoisted(() => ({ owner: vi.fn(async () => {}), ops: vi.fn(async () => {}) }));
const tracking = vi.hoisted(() => ({
  pool: vi.fn(), redis: { set: vi.fn(async () => { throw new Error('regional Redis down'); }) },
}));
vi.mock('./idle-pause-emails.js', () => ({ sendIdlePauseEmail: emails.owner, sendIdlePauseBreakerEmail: emails.ops }));
vi.mock('./region-resolver.js', () => ({ resolveAppHomeRegion: async () => 'test-region' }));
vi.mock('./redis-registry.js', () => ({ redisFor: () => tracking.redis }));
vi.mock('./runtime-db.js', () => ({ getRuntimeDbPool: tracking.pool }));
vi.mock('../config.js', () => ({ config: { runtimeDb: {} } }));
const { markAppActive } = await import('./app-activity.js');
const { onPauseStateChanged } = await import('./app-pause.js');
const { runIdlePauseOnce, startIdlePauseReaper } = await import('./idle-app-reaper.js');
const { idlePauseConfigFromEnv } = await import('./idle-pause-config.js');

// Opt in explicitly; never reuse the application's configured databases.
const url = process.env.IDLE_PAUSE_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
const freeOrg = '00000000-0000-0000-0000-000000000001';
const paidOrg = '00000000-0000-0000-0000-000000000002';
const suspendedOrg = '00000000-0000-0000-0000-000000000003';
const cfg = { ...idlePauseConfigFromEnv({ BUTTERBASE_IDLE_PAUSE_DAYS: '28' })!, maxFraction: 1 };
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

suite('idle reaper SQL safety (real Postgres)', () => {
  const suffix = randomUUID().replaceAll('-', '');
  const controlSchema = `idle_control_${suffix}`;
  const runtimeSchema = `idle_runtime_${suffix}`;
  let admin: pg.Pool, control: pg.Pool, runtime: pg.Pool;
  let lock: string | null;
  const redis = {
    set: vi.fn(async (_key: string, token: string) => { if (lock) return null; lock = token; return 'OK'; }),
    eval: vi.fn(async (_script: string, _keys: number, _key: string, token: string, ttl?: number) => {
      if (lock !== token) return 0;
      if (ttl === undefined) lock = null;
      return 1;
    }),
  };
  const deps = () => ({ controlDb: control, runtimeDb: (_region: string) => runtime, redis, log });
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA ${controlSchema}; CREATE SCHEMA ${runtimeSchema}`);
    control = new pg.Pool({ connectionString: url, options: `-c search_path=${controlSchema}` });
    runtime = new pg.Pool({ connectionString: url, options: `-c search_path=${runtimeSchema}` });
    await control.query(`CREATE TABLE organizations(id uuid PRIMARY KEY, plan_id text, account_status text);
      CREATE TABLE org_app_index(app_id text PRIMARY KEY, organization_id uuid, region text);
      CREATE TABLE frontend_visit_daily(app_id text, day date, unique_visitor_count integer, PRIMARY KEY(app_id, day));
      INSERT INTO organizations VALUES ('${freeOrg}','playground','active'), ('${paidOrg}','launch','active'), ('${suspendedOrg}','playground','suspended');`);
    await runtime.query(`CREATE TABLE apps(id text PRIMARY KEY, name text, organization_id uuid, provisioning_status text DEFAULT 'ready',
      paused boolean DEFAULT false, paused_at timestamptz, paused_reason text, paused_by text, updated_at timestamptz DEFAULT now(),
      last_active_at timestamptz, idle_warned_at timestamptz, idle_reminded_at timestamptz, idle_pause_notified_at timestamptz);
      CREATE TABLE app_environments(staging_app_id text);`);
  });
  afterAll(async () => {
    await Promise.all([control?.end(), runtime?.end()]);
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${controlSchema} CASCADE; DROP SCHEMA IF EXISTS ${runtimeSchema} CASCADE`); await admin.end(); }
  });
  beforeEach(async () => {
    lock = null; vi.clearAllMocks();
    tracking.pool.mockReturnValue(runtime);
    await control.query(`TRUNCATE org_app_index,frontend_visit_daily; UPDATE organizations SET plan_id = 'playground' WHERE id = '${freeOrg}'`);
    await runtime.query('TRUNCATE apps,app_environments');
  });
  async function insert(id: string, org: string | null = freeOrg, opts: { age?: number | null; warned?: number; reminded?: number | null; notified?: number; ready?: boolean; paused?: boolean } = {}) {
    await control.query('INSERT INTO org_app_index VALUES ($1,$2,$3)', [id, org, 'test-region']);
    await runtime.query(`INSERT INTO apps(id,name,organization_id,last_active_at,idle_warned_at,idle_reminded_at,idle_pause_notified_at,provisioning_status,paused)
      VALUES ($1,$1,$2,now()-$3::int*interval '1 day',now()-$4::int*interval '1 day',now()-$5::int*interval '1 day',now()-$6::int*interval '1 day',$7,$8)`,
      [id, org, opts.age === undefined ? 40 : opts.age, opts.warned ?? null, opts.reminded === undefined ? (opts.warned ? 4 : null) : opts.reminded, opts.notified ?? null, opts.ready === false ? 'creating' : 'ready', opts.paused ?? false]);
  }
  async function row(id: string) { return (await runtime.query('SELECT * FROM apps WHERE id=$1', [id])).rows[0]; }

  it('adds the reminder marker without changing existing activity and can be rerun', async () => {
    await insert('app_migration');
    const before = await row('app_migration');
    await runtime.query('ALTER TABLE apps DROP COLUMN idle_reminded_at');
    const sql = readFileSync(new URL('../../../../db/runtime-plane/059_app_idle_reminder.sql', import.meta.url), 'utf8');
    expect(sql.trimStart().startsWith('-- @scope: runtime')).toBe(true);
    await runtime.query(sql); await runtime.query(sql);
    const after = await row('app_migration');
    expect(after.idle_reminded_at).toBeNull(); expect(after.last_active_at).toEqual(before.last_active_at);
    expect(after.paused).toBe(before.paused); expect(after.idle_warned_at).toEqual(before.idle_warned_at);
  });

  it('delivers three ordered notices at 7/11/14 days and pauses after seven more days', async () => {
    const target = { ...cfg, days: 14, warnDays: 7, reminderDays: 3, graceDays: 7 };
    await insert('app_three', freeOrg, { age: 6 });
    expect(await runIdlePauseOnce(deps(), target)).toMatchObject({ warned: 0, reminded: 0, notified: 0, paused: 0 });
    await runtime.query("UPDATE apps SET last_active_at=now()-interval '7 days 1 hour' WHERE id='app_three'");
    expect(await runIdlePauseOnce(deps(), target)).toMatchObject({ warned: 1, reminded: 0, notified: 0, paused: 0 });
    expect(await runIdlePauseOnce(deps(), target)).toMatchObject({ warned: 0, reminded: 0 });
    await runtime.query("UPDATE apps SET last_active_at=now()-interval '11 days 1 hour',idle_warned_at=now()-interval '4 days 1 hour' WHERE id='app_three'");
    expect(await runIdlePauseOnce(deps(), target)).toMatchObject({ reminded: 1, notified: 0, paused: 0 });
    expect((await row('app_three')).idle_reminded_at).not.toBeNull();
    expect(await runIdlePauseOnce(deps(), target)).toMatchObject({ reminded: 0, notified: 0 });
    await runtime.query("UPDATE apps SET last_active_at=now()-interval '14 days 1 hour',idle_warned_at=now()-interval '7 days 1 hour',idle_reminded_at=now()-interval '2 days' WHERE id='app_three'");
    expect(await runIdlePauseOnce(deps(), target)).toMatchObject({ notified: 0 });
    await runtime.query("UPDATE apps SET idle_reminded_at=now()-interval '3 days 1 hour' WHERE id='app_three'");
    expect(await runIdlePauseOnce(deps(), target)).toMatchObject({ notified: 1, paused: 0 });
    await runtime.query("UPDATE apps SET idle_pause_notified_at=now()-interval '6 days' WHERE id='app_three'");
    expect(await runIdlePauseOnce(deps(), target)).toMatchObject({ paused: 0 });
    await runtime.query("UPDATE apps SET idle_pause_notified_at=now()-interval '7 days 1 hour' WHERE id='app_three'");
    expect(await runIdlePauseOnce(deps(), target)).toMatchObject({ paused: 1 });
    expect(emails.owner.mock.calls.map(c => [c[2], c[3]])).toEqual([
      ['project_idle_warning',7], ['project_idle_reminder',3], ['project_paused_idle',7],
    ]);
  });

  it('gives an overdue app its full warning and reminder lead time', async () => {
    const target = { ...cfg, days: 14, warnDays: 7, reminderDays: 3, graceDays: 7 };
    await insert('app_late');
    expect(await runIdlePauseOnce(deps(), target)).toMatchObject({ warned: 1, reminded: 0, notified: 0 });
    expect(emails.owner.mock.calls[0]?.[5]).toBe(40);
    await runtime.query("UPDATE apps SET idle_warned_at=now()-interval '3 days' WHERE id='app_late'");
    expect(await runIdlePauseOnce(deps(), target)).toMatchObject({ reminded: 0, notified: 0 });
    await runtime.query("UPDATE apps SET idle_warned_at=now()-interval '8 days' WHERE id='app_late'");
    expect(await runIdlePauseOnce(deps(), target)).toMatchObject({ reminded: 1, notified: 0 });
    expect(await runIdlePauseOnce(deps(), target)).toMatchObject({ notified: 0 });
  });

  it('does not send retroactive reminders to apps already in grace', async () => {
    await insert('app_legacy_grace', freeOrg, { warned: 15, reminded: null, notified: 4 });
    expect(await runIdlePauseOnce(deps(), cfg)).toMatchObject({ reminded: 0, notified: 0, paused: 0 });
    expect(emails.owner).not.toHaveBeenCalled();
  });

  it('preserves the original two-email path when there is no room for a separate reminder', async () => {
    await insert('app_short_warning', freeOrg, { warned: 2, reminded: null });
    const short = { ...cfg, days: 14, warnDays: 1, reminderDays: 0 };
    expect(await runIdlePauseOnce(deps(), short)).toMatchObject({ reminded: 0, notified: 1, paused: 0 });
    expect(emails.owner.mock.calls[0]?.[2]).toBe('project_paused_idle');
  });

  it('discovers each staged transition on recurring real timers without calling a sweep', async () => {
    vi.stubEnv('BUTTERBASE_IDLE_PAUSE_DAYS', '14');
    vi.stubEnv('BUTTERBASE_IDLE_PAUSE_WARN_DAYS', '7');
    vi.stubEnv('BUTTERBASE_IDLE_PAUSE_REMINDER_DAYS', '3');
    vi.stubEnv('BUTTERBASE_IDLE_PAUSE_GRACE_DAYS', '7');
    vi.stubEnv('BUTTERBASE_IDLE_PAUSE_MAX_FRACTION', '1');
    await insert('app_timer', freeOrg, { age: 1 });
    const stop = startIdlePauseReaper(deps(), 50);
    try {
      await vi.waitFor(() => expect(log.info).toHaveBeenCalledWith(expect.anything(), '[idle-pause-reaper] tick complete'));
      await runtime.query("UPDATE apps SET last_active_at=now()-interval '7 days 1 hour' WHERE id='app_timer'");
      await vi.waitFor(() => expect(emails.owner).toHaveBeenCalledTimes(1));
      await runtime.query("UPDATE apps SET last_active_at=now()-interval '11 days 1 hour',idle_warned_at=now()-interval '4 days 1 hour' WHERE id='app_timer'");
      await vi.waitFor(() => expect(emails.owner).toHaveBeenCalledTimes(2));
      await runtime.query("UPDATE apps SET last_active_at=now()-interval '14 days 1 hour',idle_warned_at=now()-interval '7 days 1 hour',idle_reminded_at=now()-interval '3 days 1 hour' WHERE id='app_timer'");
      await vi.waitFor(() => expect(emails.owner).toHaveBeenCalledTimes(3));
      expect((await row('app_timer')).paused).toBe(false);
      await runtime.query("UPDATE apps SET idle_pause_notified_at=now()-interval '7 days 1 hour' WHERE id='app_timer'");
      await vi.waitFor(async () => expect((await row('app_timer')).paused_by).toBe('idle_reaper'));
      expect(emails.owner.mock.calls.map(c => c[2])).toEqual(['project_idle_warning','project_idle_reminder','project_paused_idle']);
    } finally { await stop(); vi.unstubAllEnvs(); }
  });

  it('returning HTTP and qualifying frontend traffic clear the reminder marker', async () => {
    await insert('app_http_reset', freeOrg, { warned: 15, reminded: 4 });
    await insert('app_frontend_reset', freeOrg, { warned: 15, reminded: 4 });
    await markAppActive(control, 'app_http_reset', log);
    expect((await row('app_http_reset')).idle_reminded_at).toBeNull();
    await control.query("INSERT INTO frontend_visit_daily VALUES ('app_frontend_reset',CURRENT_DATE,3)");
    await runIdlePauseOnce(deps(), cfg);
    expect((await row('app_frontend_reset')).idle_reminded_at).toBeNull();
  });

  it('warns, notifies, and pauses only after the full warning and grace intervals', async () => {
    await insert('app_warn'); await insert('app_notify', freeOrg, { warned: 8 });
    await insert('app_pause', freeOrg, { warned: 15, notified: 6 });
    await insert('app_wait_warn', freeOrg, { warned: 6 });
    await insert('app_wait_grace', freeOrg, { warned: 15, notified: 4 });
    const result = await runIdlePauseOnce(deps(), cfg);
    expect(result).toMatchObject({ warned: 1, notified: 1, paused: 1, breaker: false });
    expect((await row('app_warn')).idle_warned_at).not.toBeNull();
    expect((await row('app_notify')).idle_pause_notified_at).not.toBeNull();
    expect((await row('app_notify')).paused).toBe(false);
    expect((await row('app_pause')).paused_by).toBe('idle_reaper');
    expect((await row('app_wait_warn')).idle_pause_notified_at).toBeNull();
    expect((await row('app_wait_grace')).paused).toBe(false);
    expect(emails.owner).toHaveBeenCalledTimes(2);
  });
  it('excludes paid, suspended, staging, NULL-org, NULL-activity, active, provisioning and visited apps', async () => {
    await insert('app_paid', paidOrg); await insert('app_suspended', suspendedOrg); await insert('app_null_org', null);
    await insert('app_null_time', freeOrg, { age: null }); await insert('app_active', freeOrg, { age: 1 });
    await insert('app_creating', freeOrg, { ready: false }); await insert('app_paused', freeOrg, { paused: true });
    await insert('app_staging'); await runtime.query("INSERT INTO app_environments VALUES ('app_staging')");
    await insert('app_visited'); await control.query("INSERT INTO frontend_visit_daily VALUES ('app_visited',CURRENT_DATE,3)");
    expect(await runIdlePauseOnce(deps(), cfg)).toMatchObject({ warned: 0, notified: 0, paused: 0 });
    expect(emails.owner).not.toHaveBeenCalled();
  });
  it('dry run logs every proposed stage without database writes or emails', async () => {
    await insert('app_warn'); await insert('app_pause', freeOrg, { warned: 15, notified: 6 });
    const before = (await runtime.query('SELECT * FROM apps ORDER BY id')).rows;
    await runIdlePauseOnce(deps(), { ...cfg, dryRun: true });
    expect((await runtime.query('SELECT * FROM apps ORDER BY id')).rows).toEqual(before);
    expect(emails.owner).not.toHaveBeenCalled(); expect(emails.ops).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }), expect.any(String));
    expect(log.info).toHaveBeenCalledWith(expect.objectContaining({
      apps: expect.arrayContaining([expect.objectContaining({ id: 'app_pause', plan: 'playground', region: 'test-region' })]),
    }), expect.any(String));
  });
  it.each([{ maxPerTick: 1 }, { maxFraction: 0.2 }])('breaker blocks both notification and pause, but warning still runs (%j)', async (limit) => {
    await insert('app_warn'); await insert('app_notify', freeOrg, { warned: 8 });
    await insert('app_pause', freeOrg, { warned: 15, notified: 6 });
    expect(await runIdlePauseOnce(deps(), { ...cfg, ...limit })).toMatchObject({ breaker: true, warned: 1, notified: 0, paused: 0 });
    expect((await row('app_pause')).paused).toBe(false);
    expect((await row('app_notify')).idle_pause_notified_at).toBeNull();
    expect(emails.ops).toHaveBeenCalledOnce();
  });
  it('rechecks activity and frontend visits after selecting candidates', async () => {
    await insert('app_traffic', freeOrg, { warned: 15, notified: 6 });
    await insert('app_visit', freeOrg, { warned: 15, notified: 6 });
    const query = control.query.bind(control);
    let selects = 0;
    const controlProxy = { connect: control.connect.bind(control), query: async (...args: any[]) => {
      const result = await (query as any)(...args);
      if (String(args[0]).includes('FROM org_app_index') && ++selects === 2) {
        await runtime.query("UPDATE apps SET last_active_at=now(),idle_warned_at=NULL,idle_pause_notified_at=NULL WHERE id='app_traffic'");
        await query("INSERT INTO frontend_visit_daily VALUES ('app_visit',CURRENT_DATE,3)");
      }
      return result;
    } };
    await runIdlePauseOnce({ ...deps(), controlDb: controlProxy as never }, cfg);
    expect((await row('app_traffic')).paused).toBe(false); expect((await row('app_visit')).paused).toBe(false);
  });
  it('never leaves a paid app paused when upgrade happens during the runtime UPDATE', async () => {
    await insert('app_upgrade', freeOrg, { warned: 15, notified: 6 });
    const query = runtime.query.bind(runtime);
    const runtimeProxy = { query: async (...args: any[]) => {
      if (String(args[0]).includes('SET paused = true')) await control.query("UPDATE organizations SET plan_id='launch' WHERE id=$1", [freeOrg]);
      return (query as any)(...args);
    } };
    await runIdlePauseOnce({ ...deps(), runtimeDb: () => runtimeProxy as never }, cfg);
    expect((await row('app_upgrade')).paused).toBe(false);
  });
  it('skips an old regional candidate if cutover completes just before its app lock', async () => {
    await insert('app_moved');
    let moved = false;
    const proxy = { query: control.query.bind(control), connect: async () => {
      const c = await control.connect();
      return { release:()=>c.release(), query:async (...args:any[]) => {
        const result = await (c.query.bind(c) as any)(...args);
        if (!moved && String(args[0]).includes('SET LOCAL lock_timeout')) {
          moved=true; await control.query("UPDATE org_app_index SET region='new-region' WHERE app_id='app_moved'");
        }
        return result;
      } };
    } };
    expect(await runIdlePauseOnce({ ...deps(),controlDb:proxy as never },cfg)).toMatchObject({ warned:0,notified:0,paused:0 });
    expect((await row('app_moved')).idle_warned_at).toBeNull();
  });
  it('does not write when another worker owns the shared lease', async () => {
    await insert('app_warn'); lock = 'other-worker';
    expect(await runIdlePauseOnce(deps(), cfg)).toMatchObject({ locked: true });
    expect((await row('app_warn')).idle_warned_at).toBeNull(); expect(lock).toBe('other-worker');
  });
  it('qualifying frontend traffic cancels pending warning and grace state', async () => {
    await insert('app_returned', freeOrg, { warned: 15, notified: 4 });
    await control.query("INSERT INTO frontend_visit_daily VALUES ('app_returned',CURRENT_DATE,3)");
    await runIdlePauseOnce(deps(), cfg);
    const app = await row('app_returned');
    expect(app.idle_warned_at).toBeNull(); expect(app.idle_pause_notified_at).toBeNull();
    expect(app.paused).toBe(false);
  });
  it('real returning traffic survives a regional Redis outage and cancels a due pause', async () => {
    await insert('app_redis_returned', freeOrg, { warned: 15, notified: 6 });
    await markAppActive(control, 'app_redis_returned', log);
    const app = await row('app_redis_returned');
    expect(app.last_active_at.getTime()).toBeGreaterThan(Date.now() - 10000);
    expect(app.idle_warned_at).toBeNull(); expect(app.idle_pause_notified_at).toBeNull();
    await runIdlePauseOnce(deps(), cfg);
    expect((await row('app_redis_returned')).paused).toBe(false);
  });
  it('finishes committed pause effects before stop resolves', async () => {
    await insert('app_draining', freeOrg, { warned: 15, notified: 6 });
    vi.stubEnv('BUTTERBASE_IDLE_PAUSE_DAYS', '28'); vi.stubEnv('BUTTERBASE_IDLE_PAUSE_MAX_FRACTION', '1');
    let finish!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let effectsDone = false;
    const unsubscribe = onPauseStateChanged(async (change) => {
      if (change.appId === 'app_draining' && change.paused) { entered(); await gate; effectsDone = true; }
    });
    const stop = startIdlePauseReaper(deps());
    try {
      await started;
      expect((await row('app_draining')).paused).toBe(true);
      let drained = false;
      const draining = stop().then(() => { drained = true; });
      await new Promise((resolve) => setImmediate(resolve));
      expect(drained).toBe(false);
      finish(); await draining;
      expect(effectsDone).toBe(true);
    } finally { finish(); await stop(); unsubscribe(); vi.unstubAllEnvs(); }
  });
  it('shutdown prevents a subsequent batch while retaining effects for committed rows', async () => {
    await insert('app_warn'); await insert('app_pause', freeOrg, { warned: 15, notified: 6 });
    const abort = new AbortController();
    emails.owner.mockImplementationOnce(async () => { abort.abort(); });
    await expect(runIdlePauseOnce({ ...deps(), signal: abort.signal }, cfg)).rejects.toThrow('stopped');
    expect((await row('app_warn')).idle_warned_at).not.toBeNull();
    expect((await row('app_pause')).paused).toBe(false);
  });
  it('losing the lease before mutation prevents all writes and does not delete another worker\'s lease', async () => {
    await insert('app_warn');
    redis.eval.mockImplementationOnce(async () => { lock = 'new-owner'; return 0; });
    await expect(runIdlePauseOnce(deps(), cfg)).rejects.toThrow('lease lost');
    expect((await row('app_warn')).idle_warned_at).toBeNull(); expect(lock).toBe('new-owner');
  });
  it('aborts mutation when a region cannot be scanned, since the global breaker would be incomplete', async () => {
    await insert('app_warn');
    await control.query("INSERT INTO org_app_index VALUES ('app_unknown_region',$1,'offline')", [freeOrg]);
    await runIdlePauseOnce({ ...deps(), runtimeDb: (region) => { if (region === 'offline') throw new Error('offline'); return runtime; } }, cfg);
    expect((await row('app_warn')).idle_warned_at).toBeNull(); expect(log.error).toHaveBeenCalled();
  });
  it.skipIf(!process.env.IDLE_PAUSE_TEST_REDIS_URL)('uses a real Redis lease to exclude concurrent workers and release only its token', async () => {
    const client = new Redis(process.env.IDLE_PAUSE_TEST_REDIS_URL!);
    const key = 'lock:idle-pause-reaper';
    let finish!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const query = control.query.bind(control);
    let first = true;
    const slowControl = { connect: control.connect.bind(control), query: async (...args: any[]) => {
      if (first) { first = false; entered(); await gate; }
      return (query as any)(...args);
    } };
    try {
      await client.del(key);
      const pending = runIdlePauseOnce({ ...deps(), redis: client, controlDb: slowControl as never }, cfg);
      await started;
      expect(await runIdlePauseOnce({ ...deps(), redis: client }, cfg)).toMatchObject({ locked: true });
      finish(); await pending;
      expect(await client.get(key)).toBeNull();

      await insert('app_real_lease');
      const runtimeQuery = runtime.query.bind(runtime);
      const leaseStealer = { query: async (...args: any[]) => {
        const result = await (runtimeQuery as any)(...args);
        if (String(args[0]).includes('CASE WHEN')) await client.set(key, 'new-owner', 'EX', 60);
        return result;
      } };
      await expect(runIdlePauseOnce({ ...deps(), redis: client, runtimeDb: () => leaseStealer as never }, cfg)).rejects.toThrow('lease lost');
      expect(await client.get(key)).toBe('new-owner');
      expect((await row('app_real_lease')).idle_warned_at).toBeNull();
    } finally { finish(); await client.del(key); await client.quit(); }
  });
});
