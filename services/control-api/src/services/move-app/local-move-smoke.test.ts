import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { config, assertRuntimeDbConfig } from '../../config.js';
import { getRuntimeDbPool, _resetRuntimeDbPools } from '../runtime-db.js';
import { shutdownAllKvRedisClients } from '../kv/redis-registry.js';
import { provisionAppDb, custDbNameFor } from '../provisioner.js';
import { driveOnce } from './saga-executor.js';
import { HAPPY_PATH_ORDER, type MigrationRow } from './migration-store.js';
import { stepHandlers } from './step-registry.js';

// Dedicated disposable fixtures only. No Neon credentials, managed scheduler,
// Cloudflare or object-store account is required. pg_dump/psql must be on PATH.
const pgUrl = process.env.LOCAL_MOVE_SMOKE_PG_URL;
const sourceRedisUrl = process.env.LOCAL_MOVE_SMOKE_REDIS_SOURCE_URL;
const destRedisUrl = process.env.LOCAL_MOVE_SMOKE_REDIS_DEST_URL;
const enabled = !!(pgUrl && sourceRedisUrl && destRedisUrl);

function captureDump(uri: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('pg_dump', ['--no-owner', '--no-privileges', '--clean', '--if-exists', uri]);
    const chunks: Buffer[] = [];
    let size = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1024 * 1024) { child.kill(); reject(new Error('fixture dump exceeds 1 MiB')); }
      else chunks.push(chunk);
    });
    child.stderr.resume();
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`fixture pg_dump exited ${code}`)));
  });
}

describe.skipIf(!enabled)('local move saga — real Postgres/Redis smoke (#42)', () => {
  const salt = randomUUID().replace(/-/g, '').slice(0, 10);
  const appId = `app_smoke_${salt}`;
  const abortAppId = `app_abort_${salt}`;
  const ownerId = randomUUID();
  const migrationId = randomUUID();
  const sourceRegion = 'us-east-1';
  const destRegion = 'eu-west-1';
  const names = [`bb_move_control_${salt}`, `bb_move_source_${salt}`, `bb_move_dest_${salt}`, `bb_move_data_${salt}`];
  let admin: pg.Pool;
  let control: pg.Pool;
  let source: pg.Pool;
  let dest: pg.Pool;
  let sourceData: pg.Pool;
  let sourceRedis: Redis;
  let destRedis: Redis;
  let sourceDataUrl: string;
  const ownedPools: pg.Pool[] = [];
  const dumps = new Map<string, Buffer>();
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const databaseUrl = (name: string) => { const u = new URL(pgUrl!); u.pathname = `/${name}`; u.searchParams.delete('dbname'); return u.toString(); };
  const runtimePoolFor = (region: string) => region === sourceRegion ? source : dest;
  const readUri = async (region: string, id: string) => {
    const result = await runtimePoolFor(region).query('SELECT connection_string FROM app_db_connections WHERE app_id = $1', [id]);
    if (!result.rows[0]) throw new Error('fixture customer connection missing');
    return result.rows[0].connection_string as string;
  };
  const ctx = {
    get controlPool() { return control; }, runtimePoolFor,
    redisFor: (region: string) => region === sourceRegion ? sourceRedis : destRedis, log,
    provisionAppDb,
    readSourceConnectionUri: readUri, readDestConnectionUri: readUri,
    uploadDump: async (key: string) => { const body = await captureDump(sourceDataUrl); dumps.set(key, body); return { key, bytes: body.length }; },
    downloadDump: async (_region: string, key: string) => ({ stream: Readable.from([dumps.get(key)!]) }),
    uploadKvDump: async (key: string, body: Readable) => { const chunks: Buffer[] = []; for await (const chunk of body) chunks.push(Buffer.from(chunk)); const data = Buffer.concat(chunks); dumps.set(key, data); return { key, bytes: data.length }; },
    downloadKvDump: async (key: string) => Readable.from([dumps.get(key)!]),
    updateOrgAppIndexRegion: async (pool: pg.Pool, id: string, region: string) => { await pool.query('UPDATE org_app_index SET region = $2 WHERE app_id = $1', [id, region]); },
    // No real public domains or reverse replication in this self-host smoke.
  };

  beforeAll(async () => {
    vi.stubEnv('BUTTERBASE_LOCAL', 'true');
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('BUTTERBASE_REGIONS', `${sourceRegion},${destRegion}`);
    vi.stubEnv('BUTTERBASE_REGION', sourceRegion);
    vi.stubEnv('LOCAL_DATA_PLANE_URL_EU_WEST_1', pgUrl!);
    vi.stubEnv('NEON_RUNTIME_PROJECT_ID_US_EAST_1', databaseUrl(names[1]));
    vi.stubEnv('NEON_RUNTIME_PROJECT_ID_EU_WEST_1', databaseUrl(names[2]));
    vi.stubEnv('KV_REDIS_URL_US_EAST_1', sourceRedisUrl!);
    vi.stubEnv('KV_REDIS_URL_EU_WEST_1', destRedisUrl!);
    vi.stubEnv('STORAGE_PROVIDER', 'r2');
    admin = new pg.Pool({ connectionString: pgUrl, max: 1 });
    for (const name of names) await admin.query(`CREATE DATABASE "${name}"`);
    assertRuntimeDbConfig();
    control = new pg.Pool({ connectionString: databaseUrl(names[0]), max: 2 });
    source = getRuntimeDbPool(config.runtimeDb, sourceRegion);
    dest = getRuntimeDbPool(config.runtimeDb, destRegion);
    sourceDataUrl = databaseUrl(names[3]);
    sourceData = new pg.Pool({ connectionString: sourceDataUrl, max: 1 });
    ownedPools.push(control, source, dest, sourceData);
    sourceRedis = new Redis(sourceRedisUrl!);
    destRedis = new Redis(destRedisUrl!);
    await Promise.all([sourceRedis.ping(), destRedis.ping()]);
    await control.query(`
      CREATE TABLE app_migrations (id uuid PRIMARY KEY, app_id text, user_id uuid,
        source_region text, dest_region text, current_step text, step_started_at timestamptz DEFAULT now(),
        last_error text, retry_count integer DEFAULT 0, dest_resources jsonb DEFAULT '{}',
        source_replica_state text, initiated_at timestamptz DEFAULT now(), completed_at timestamptz);
      CREATE TABLE org_app_index (app_id text PRIMARY KEY, region text);
      CREATE TABLE app_kv_credentials (app_id text PRIMARY KEY, region text, rotated_at timestamptz);`);
    for (const pool of [source, dest]) await pool.query(`
      CREATE TABLE apps (id text PRIMARY KEY, name text, owner_id uuid, db_name text, subdomain text,
        region text, provisioning_status text, db_provisioned boolean DEFAULT false, updated_at timestamptz DEFAULT now());
      CREATE TABLE app_db_connections (app_id text PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
        connection_string text NOT NULL, pooler_connection_string text, neon_project_id text, neon_database_name text);
      CREATE TABLE agent_runs (id uuid PRIMARY KEY, app_id text, status text, archived_after_move uuid);
      CREATE TABLE agent_checkpoints (id uuid PRIMARY KEY, run_id uuid REFERENCES agent_runs(id), payload jsonb, archived_after_move uuid);`);
    await sourceData.query("CREATE TABLE local_move_probe (id integer PRIMARY KEY, note text); INSERT INTO local_move_probe VALUES (1, '移行確認'), (2, 'retained data')");
    for (const id of [appId, abortAppId]) {
      await source.query("INSERT INTO apps (id,name,owner_id,db_name,region,provisioning_status,db_provisioned) VALUES ($1,'smoke',$2,$3,$4,'ready',true)", [id, ownerId, names[3], sourceRegion]);
      await source.query('INSERT INTO app_db_connections (app_id,connection_string,neon_database_name) VALUES ($1,$2,$3)', [id, sourceDataUrl, names[3]]);
      await control.query('INSERT INTO org_app_index VALUES ($1,$2)', [id, sourceRegion]);
      await control.query('INSERT INTO app_kv_credentials (app_id,region) VALUES ($1,$2)', [id, 'us']);
    }
    const runId = randomUUID();
    await source.query("INSERT INTO agent_runs VALUES ($1,$2,'completed',null)", [runId, appId]);
    await source.query("INSERT INTO agent_checkpoints VALUES ($1,$2,'{\"fixture\":true}',null)", [randomUUID(), runId]);
    await source.query("INSERT INTO agent_runs VALUES ($1,'another-app','completed',null)", [randomUUID()]);
    await sourceRedis.set(`{${appId}}:probe`, 'preserved KV');
    await control.query("INSERT INTO app_migrations (id,app_id,user_id,source_region,dest_region,current_step) VALUES ($1,$2,$3,$4,$5,'requested')", [migrationId, appId, ownerId, sourceRegion, destRegion]);
  }, 30000);

  afterAll(async () => {
    await shutdownAllKvRedisClients();
    if (sourceRedis) { await sourceRedis.del(`{${appId}}:probe`, `{${appId}}:_meta:migration`, `{${abortAppId}}:_meta:migration`); await sourceRedis.quit(); }
    if (destRedis) { await destRedis.del(`{${appId}}:probe`); await destRedis.quit(); }
    await Promise.all(ownedPools.map(pool => pool.end()));
    _resetRuntimeDbPools();
    if (admin) {
      for (const name of [...names, custDbNameFor(appId, destRegion), custDbNameFor(abortAppId, destRegion)]) {
        // pg-pool.end() can resolve before the server observes socket closure.
        // Do not FORCE-kill those closing clients (57P01 becomes unhandled).
        for (let attempt = 0; ; attempt++) {
          try { await admin.query(`DROP DATABASE IF EXISTS "${name}"`); break; }
          catch (error) {
            if ((error as { code?: string }).code !== '55006' || attempt >= 20) throw error;
            await new Promise(resolve => setTimeout(resolve, 10));
          }
        }
      }
      await admin.end();
    }
    vi.unstubAllEnvs();
  }, 30000);

  it('completes every forward step and preserves customer, child-table and KV data', async () => {
    for (const step of HAPPY_PATH_ORDER.slice(1)) {
      await driveOnce(ctx, stepHandlers);
      const current = (await control.query<MigrationRow>('SELECT * FROM app_migrations WHERE id=$1', [migrationId])).rows[0];
      expect(current.last_error).toBeNull();
      expect(current.current_step).toBe(step);
      if (step === 'dumping_data') expect(await sourceRedis.get(`{${appId}}:_meta:migration`)).toBe('1');
    }
    expect(await sourceRedis.get(`{${appId}}:_meta:migration`)).toBeNull();
    expect(await destRedis.get(`{${appId}}:probe`)).toBe('preserved KV');
    expect((await dest.query('SELECT status FROM agent_runs')).rows).toEqual([{ status: 'completed' }]);
    expect((await dest.query('SELECT payload FROM agent_checkpoints')).rows).toEqual([{ payload: { fixture: true } }]);
    expect((await dest.query('SELECT db_provisioned,provisioning_status FROM apps WHERE id=$1', [appId])).rows[0]).toEqual({ db_provisioned: true, provisioning_status: 'ready' });
    expect((await control.query('SELECT region FROM org_app_index WHERE app_id=$1', [appId])).rows[0].region).toBe(destRegion);
    const customerUri = await readUri(destRegion, appId);
    expect(customerUri).not.toBe(sourceDataUrl);
    const customer = new pg.Pool({ connectionString: customerUri });
    try {
      expect((await customer.query('SELECT current_database() AS name')).rows[0].name).toBe(custDbNameFor(appId, destRegion));
      expect((await customer.query('SELECT * FROM local_move_probe ORDER BY id')).rows).toEqual([{ id: 1, note: '移行確認' }, { id: 2, note: 'retained data' }]);
    }
    finally { await customer.end(); }
  }, 30000);

  it('compensates a local abort without requiring a Neon project', async () => {
    const abortId = randomUUID();
    await control.query("INSERT INTO app_migrations (id,app_id,user_id,source_region,dest_region,current_step) VALUES ($1,$2,$3,$4,$5,'requested')", [abortId, abortAppId, ownerId, sourceRegion, destRegion]);
    for (let i = 0; i < 3; i++) await driveOnce(ctx, stepHandlers);
    expect(await sourceRedis.get(`{${abortAppId}}:_meta:migration`)).toBe('1');
    await control.query("UPDATE app_migrations SET current_step='aborting' WHERE id=$1", [abortId]);
    await driveOnce(ctx, stepHandlers);
    expect((await control.query('SELECT current_step FROM app_migrations WHERE id=$1', [abortId])).rows[0].current_step).toBe('aborted');
    expect((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [custDbNameFor(abortAppId, destRegion)])).rows).toEqual([]);
    expect((await dest.query('SELECT 1 FROM apps WHERE id=$1', [abortAppId])).rows).toEqual([]);
    expect((await source.query('SELECT provisioning_status FROM apps WHERE id=$1', [abortAppId])).rows[0].provisioning_status).toBe('ready');
    expect(await sourceRedis.get(`{${abortAppId}}:_meta:migration`)).toBeNull();
  }, 30000);
});
