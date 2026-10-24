import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { Redis } from 'ioredis';
import Fastify from 'fastify';

// Explicit opt-in databases containing the real migrated control/runtime schemas.
// Never infer credentials from the application configuration.
const endpoints = {
  control: process.env.IDLE_PAUSE_TEST_CONTROL_URL,
  runtime: process.env.IDLE_PAUSE_TEST_RUNTIME_URL,
  redis: process.env.IDLE_PAUSE_TEST_REDIS_URL,
};
const state = vi.hoisted(() => ({ runtime: null as unknown as pg.Pool, redis: null as unknown as Redis }));
const mail = vi.hoisted(() => ({ owner: vi.fn(async () => {}), ops: vi.fn(async () => {}) }));
vi.mock('../config.js', () => ({ config: { runtimeDb: {}, dashboardUrl: 'http://localhost:3000' } }));
vi.mock('./runtime-db.js', () => ({ getRuntimeDbPool: () => state.runtime }));
vi.mock('./region-resolver.js', () => ({
  resolveAppHomeRegion: async () => 'us-east-1', getRuntimeDbForApp: async () => state.runtime,
}));
vi.mock('./redis.js', () => ({ getRedisClient: () => state.redis }));
vi.mock('./redis-registry.js', () => ({ redisFor: () => state.redis }));
vi.mock('./runtime-pool-registry.js', () => ({ listRuntimeRegions: () => ['us-east-1'] }));
vi.mock('./idle-pause-emails.js', () => ({ sendIdlePauseEmail: mail.owner, sendIdlePauseBreakerEmail: mail.ops }));
vi.mock('./audit/with-audit.js', () => ({ logFromRequest: vi.fn() }));
vi.mock('./app-plan-resolver.js', () => ({ getLimitsForApp: vi.fn() }));

const { runIdlePauseOnce } = await import('./idle-app-reaper.js');
const { idlePauseConfigFromEnv } = await import('./idle-pause-config.js');
const { resumeIdlePausedAppsForOrg } = await import('./idle-pause-upgrade.js');
const { onPauseStateChanged } = await import('./app-pause.js');
const { AppPausedError } = await import('./app-resolver.js');
const { default: pauseGate } = await import('../plugins/pause-gate.js');
const { default: activity } = await import('../plugins/app-activity.js');
const { appConfigRoutes } = await import('../routes/app-config.js');

const suite = endpoints.control && endpoints.runtime && endpoints.redis ? describe : describe.skip;
suite('idle pause lifecycle on migrated schemas with real Redis and HTTP hooks', () => {
  const owner = randomUUID(), org = randomUUID(), appId = `app_idle_verify_${randomUUID().replaceAll('-', '')}`;
  const config = { ...idlePauseConfigFromEnv({ BUTTERBASE_IDLE_PAUSE_DAYS: '28' })!, maxFraction: 1 };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  let control: pg.Pool, runtime: pg.Pool, redis: Redis;
  let app: ReturnType<typeof Fastify>;
  const keys = [`app:active:${appId}`, `app-paused:${appId}`];
  beforeAll(async () => {
    control = new pg.Pool({ connectionString: endpoints.control });
    runtime = state.runtime = new pg.Pool({ connectionString: endpoints.runtime });
    redis = state.redis = new Redis(endpoints.redis!);
    await control.query(`INSERT INTO organizations(id,name,owner_id,plan_id) VALUES ($1,'Idle test',$2,'playground')`, [org, owner]);
    await control.query(`INSERT INTO platform_users(id,email,personal_organization_id) VALUES ($1,$2,$3)`, [owner, `${owner}@example.invalid`, org]);
    await control.query(`INSERT INTO organization_members(organization_id,user_id,role) VALUES ($1,$2,'owner')`, [org, owner]);
    await control.query(`INSERT INTO org_app_index(app_id,organization_id,region,app_name) VALUES ($1,$2,'us-east-1','Idle test')`, [appId, org]);
    await runtime.query(`INSERT INTO apps(id,name,owner_id,db_name,organization_id,region,provisioning_status)
      VALUES ($1,'Idle test',$2,$1,$3,'us-east-1','ready')`, [appId, owner, org]);
    app = Fastify();
    app.decorate('controlDb', control);
    app.decorateRequest('auth', null as never);
    app.addHook('onRequest', async (req) => {
      req.auth = req.headers['x-owner'] === '1'
        ? { userId: owner, organizationId: org, authMethod: 'api_key', scopes: ['*'] }
        : { userId: null, authMethod: 'anonymous', scopes: [] };
    });
    app.setErrorHandler((error, _req, reply) => {
      if (error instanceof AppPausedError) return reply.code(503).send({ code: 'APP_PAUSED' });
      return reply.code(500).send({ error: error.message });
    });
    await app.register(pauseGate);
    await app.register(activity);
    await app.register(appConfigRoutes);
    app.post('/v1/:appId/agents/:name/runs', async () => ({ executed: true }));
    app.get('/v1/:appId/public/data', { config: { public: true } }, async () => ({ data: 'retained' }));
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
    if (runtime) await runtime.query('DELETE FROM apps WHERE id=$1', [appId]);
    if (control) {
      await control.query('DELETE FROM org_app_index WHERE app_id=$1', [appId]);
      await control.query('DELETE FROM platform_users WHERE id=$1', [owner]);
      await control.query('DELETE FROM organizations WHERE id=$1', [org]);
    }
    if (redis) { await redis.del(...keys); await redis.quit(); }
    await Promise.all([control?.end(), runtime?.end()]);
  });
  const row = async () => (await runtime.query('SELECT * FROM apps WHERE id=$1', [appId])).rows[0];
  const sweep = () => runIdlePauseOnce({ controlDb: control, runtimeDb: () => runtime, redis, log }, config);
  const patch = (paused: boolean) => app.inject({ method: 'PATCH', url: `/v1/${appId}/config/pause`, headers: { 'x-owner': '1' }, payload: { paused } });

  it('records real HTTP activity and cancels warning/grace', async () => {
    await runtime.query(`UPDATE apps SET last_active_at=now()-interval '40 days', idle_warned_at=now()-interval '10 days', idle_pause_notified_at=now() WHERE id=$1`, [appId]);
    expect((await app.inject(`/v1/${appId}/public/data`)).statusCode).toBe(200);
    await vi.waitFor(async () => expect(Date.now() - (await row()).last_active_at.getTime()).toBeLessThan(5000));
    const after = await row();
    expect(after.idle_warned_at).toBeNull(); expect(after.idle_pause_notified_at).toBeNull();
  });

  it('warns, notifies, honors grace, pauses, rejects free resume, and resumes after upgrade', async () => {
    await redis.del(...keys);
    await runtime.query(`UPDATE apps SET last_active_at=now()-interval '40 days' WHERE id=$1`, [appId]);
    expect(await sweep()).toMatchObject({ warned: 1, notified: 0, paused: 0 });
    expect(await sweep()).toMatchObject({ warned: 0, notified: 0, paused: 0 });
    await runtime.query(`UPDATE apps SET idle_warned_at=now()-interval '8 days' WHERE id=$1`, [appId]);
    expect(await sweep()).toMatchObject({ notified: 1, paused: 0 });
    expect((await row()).paused).toBe(false);
    expect(await sweep()).toMatchObject({ paused: 0 });
    await runtime.query(`UPDATE apps SET idle_pause_notified_at=now()-interval '6 days' WHERE id=$1`, [appId]);
    expect(await sweep()).toMatchObject({ paused: 1 });
    expect((await row()).paused_by).toBe('idle_reaper');
    expect(mail.owner).toHaveBeenCalledTimes(2);
    expect((await app.inject(`/v1/${appId}/public/data`)).statusCode).toBe(503);
    expect((await app.inject({ method: 'POST', url: `/v1/${appId}/agents/echo/runs`, headers: { 'x-owner': '1' } })).statusCode).toBe(503);
    expect((await app.inject({ url: `/v1/${appId}/config`, headers: { 'x-owner': '1' } })).statusCode).toBe(200);
    expect((await patch(false)).statusCode).toBe(402);
    expect((await patch(true)).statusCode).toBe(200);
    expect((await patch(false)).statusCode).toBe(402);
    expect((await row()).paused_by).toBe('idle_reaper');
    await control.query(`UPDATE organizations SET plan_id='launch' WHERE id=$1`, [org]);
    expect(await resumeIdlePausedAppsForOrg(control, org, 'launch', log)).toEqual([appId]);
    expect((await row()).paused).toBe(false);
    expect((await row()).idle_warned_at).toBeNull();
    expect((await row()).idle_pause_notified_at).toBeNull();
    expect((await app.inject(`/v1/${appId}/public/data`)).statusCode).toBe(200);
    await runtime.query(`UPDATE apps SET last_active_at=now()-interval '100 days' WHERE id=$1`, [appId]);
    expect(await sweep()).toMatchObject({ warned: 0, notified: 0, paused: 0 });
  });

  it('rejects a stale upgrade and locks the current plan until a real resume finishes', async () => {
    await control.query(`UPDATE organizations SET plan_id='playground' WHERE id=$1`, [org]);
    await runtime.query(`UPDATE apps SET paused=true,paused_by='idle_reaper' WHERE id=$1`, [appId]);
    expect(await resumeIdlePausedAppsForOrg(control, org, 'launch', log)).toEqual([]);
    expect((await row()).paused).toBe(true);
    await control.query(`UPDATE organizations SET plan_id='launch' WHERE id=$1`, [org]);
    let downgradeBlocked = false;
    let effectsUnlocked = false;
    state.runtime = { query: async (...args: unknown[]) => {
      if (String(args[0]).includes('SET paused = false')) {
        try { await control.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE NOWAIT', [org]); }
        catch (err) { downgradeBlocked = (err as { code?: string }).code === '55P03'; }
      }
      return (runtime.query.bind(runtime) as (...a: unknown[]) => Promise<unknown>)(...args);
    } } as unknown as pg.Pool;
    const unsubscribe = onPauseStateChanged(async (change) => {
      if (change.appId !== appId || change.paused) return;
      try { await control.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE NOWAIT', [org]); effectsUnlocked = true; }
      catch { effectsUnlocked = false; }
    });
    try {
      expect(await resumeIdlePausedAppsForOrg(control, org, 'launch', log)).toEqual([appId]);
      expect(downgradeBlocked).toBe(true);
      expect(effectsUnlocked).toBe(true);
    } finally { unsubscribe(); state.runtime = runtime; }
    // The lock must be released once the helper completes.
    await expect(control.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE NOWAIT', [org])).resolves.toBeDefined();
  });

  it('migration 056 backfills existing apps safely and is idempotent', async () => {
    const schema = `idle_migration_${randomUUID().replaceAll('-', '')}`;
    const client = await runtime.connect();
    try {
      await client.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema},public;
        CREATE TABLE apps (LIKE public.apps INCLUDING ALL);
        CREATE TABLE app_environments(staging_app_id text);
        ALTER TABLE apps DROP COLUMN last_active_at, DROP COLUMN idle_warned_at, DROP COLUMN idle_pause_notified_at, DROP COLUMN paused_by;
        INSERT INTO apps(id,name,owner_id,db_name,paused,paused_reason) VALUES
          ('legacy','legacy',gen_random_uuid(),'legacy',true,'manual'),
          ('staging','staging',gen_random_uuid(),'staging',true,'Automatically paused after 7 days of inactivity.'),
          ('active','active',gen_random_uuid(),'active',false,null);
        INSERT INTO app_environments VALUES ('staging');`);
      const sql = readFileSync(new URL('../../../../db/runtime-plane/056_app_idle_pause.sql', import.meta.url), 'utf8');
      await client.query(sql);
      const first = (await client.query('SELECT id,paused_by,last_active_at FROM apps ORDER BY id')).rows;
      expect(first.map((a) => [a.id, a.paused_by])).toEqual([['active',null],['legacy','owner'],['staging','staging_reaper']]);
      expect(first.every((a) => Date.now() - a.last_active_at.getTime() < 5000)).toBe(true);
      await client.query(sql);
      expect((await client.query('SELECT id,paused_by,last_active_at FROM apps ORDER BY id')).rows).toEqual(first);
    } finally {
      await client.query(`SET search_path TO public; DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      client.release();
    }
  });
});
