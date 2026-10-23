import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';

const emails = vi.hoisted(() => ({ owner: vi.fn(async () => {}), ops: vi.fn(async () => {}) }));
vi.mock('./idle-pause-emails.js', () => ({ sendIdlePauseEmail: emails.owner, sendIdlePauseBreakerEmail: emails.ops }));
const { runIdlePauseOnce } = await import('./idle-app-reaper.js');
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
      last_active_at timestamptz, idle_warned_at timestamptz, idle_pause_notified_at timestamptz);
      CREATE TABLE app_environments(staging_app_id text);`);
  });
  afterAll(async () => {
    await Promise.all([control?.end(), runtime?.end()]);
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${controlSchema} CASCADE; DROP SCHEMA IF EXISTS ${runtimeSchema} CASCADE`); await admin.end(); }
  });
  beforeEach(async () => {
    lock = null; vi.clearAllMocks();
    await control.query(`TRUNCATE org_app_index,frontend_visit_daily; UPDATE organizations SET plan_id = 'playground' WHERE id = '${freeOrg}'`);
    await runtime.query('TRUNCATE apps,app_environments');
  });
  async function insert(id: string, org: string | null = freeOrg, opts: { age?: number | null; warned?: number; notified?: number; ready?: boolean; paused?: boolean } = {}) {
    await control.query('INSERT INTO org_app_index VALUES ($1,$2,$3)', [id, org, 'test-region']);
    await runtime.query(`INSERT INTO apps(id,name,organization_id,last_active_at,idle_warned_at,idle_pause_notified_at,provisioning_status,paused)
      VALUES ($1,$1,$2,now()-$3::int*interval '1 day',now()-$4::int*interval '1 day',now()-$5::int*interval '1 day',$6,$7)`,
      [id, org, opts.age === undefined ? 40 : opts.age, opts.warned ?? null, opts.notified ?? null, opts.ready === false ? 'creating' : 'ready', opts.paused ?? false]);
  }
  async function row(id: string) { return (await runtime.query('SELECT * FROM apps WHERE id=$1', [id])).rows[0]; }

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
    const controlProxy = { query: async (...args: any[]) => {
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
});
