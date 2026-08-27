import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { publishRelease } from '../services/template-releases.js';
import { captureAppState } from '../services/app-state-capture.js';

const CONTROL_URL = process.env.CONTROL_DB_URL
  ?? 'postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control';
const RUNTIME_URL = process.env.RUNTIME_DB_URL
  ?? 'postgresql://butterbase:butterbase_dev@localhost:5437/butterbase_runtime_us';

describe('publishRelease — concurrent publishes', () => {
  let controlDb: pg.Pool;
  const appId = 'app_concurrency_test';

  beforeAll(async () => {
    controlDb = new pg.Pool({ connectionString: CONTROL_URL });
    await controlDb.query(`DELETE FROM template_releases WHERE source_app_id = $1`, [appId]);
  });
  afterAll(async () => {
    await controlDb.query(`DELETE FROM template_releases WHERE source_app_id = $1`, [appId]);
    await controlDb.end();
  });

  it('assigns sequential numbers with no unique violation', async () => {
    const runtimePool = {
      query: async (sql: string) =>
        sql.includes('repo_latest_snapshot') ? { rows: [{ repo_latest_snapshot: 'snap_x' }] } : { rows: [] },
    } as unknown as pg.Pool;
    const appPool = { query: async () => ({ rows: [] }) } as unknown as pg.Pool;

    const results = await Promise.all([1, 2, 3].map(() =>
      publishRelease(controlDb, runtimePool, appPool, {
        sourceAppId: appId, publishedBy: 'usr_1', label: null, notes: null,
      })));

    expect(results.map((r) => r.release_number).sort()).toEqual([1, 2, 3]);
  });
});

// Regression coverage for the schema drift that let captureAppState ship
// broken: app_functions.trigger_type / trigger_config were dropped by runtime
// migration 018_function_triggers_cutover.sql, but every other test for this
// module uses a stub pool that returns canned rows regardless of the SQL
// text, so no test noticed the SELECT referencing columns that no longer
// exist. This suite runs captureAppState against a REAL runtime-plane
// Postgres so the query text is actually validated against the live schema.
//
// There's no per-app database for a synthetic app id (that's provisioned by
// /init against Neon in real usage), so introspectSchema/introspectRls are
// exercised against the runtime-plane database itself — a real Postgres
// database with a real `public` schema and real RLS policies, which is all
// those two functions need (they only touch pg_tables/pg_policies, nothing
// app-specific). The runtime pool — the one whose SQL this bug lived in — is
// never stubbed.
describe('captureAppState — real schema', () => {
  let runtimePool: pg.Pool;
  const appId = `app_capture_test_${randomUUID().slice(0, 8)}`;
  let functionId: string;

  beforeAll(async () => {
    runtimePool = new pg.Pool({ connectionString: RUNTIME_URL });

    await runtimePool.query(
      `INSERT INTO apps (id, name, owner_id, db_name)
       VALUES ($1, 'capture test app', $2, $3)`,
      [appId, randomUUID(), `db_${appId}`],
    );

    const fnRow = await runtimePool.query<{ id: string }>(
      `INSERT INTO app_functions (app_id, name, code, description)
       VALUES ($1, 'on-order-created', 'export default () => {}', 'test fixture function')
       RETURNING id`,
      [appId],
    );
    functionId = fnRow.rows[0].id;

    await runtimePool.query(
      `INSERT INTO function_triggers (function_id, app_id, trigger_type, trigger_config, enabled)
       VALUES ($1, $2, 'cron', $3::jsonb, true)`,
      [functionId, appId, JSON.stringify({ schedule: '*/5 * * * *' })],
    );
  });

  afterAll(async () => {
    // function_triggers and app_functions both cascade off apps(id) ON DELETE
    // CASCADE, but delete them explicitly (and verify) rather than relying on
    // the cascade so a failure here is loud instead of a silently-orphaned
    // fixture row in a shared dev database.
    await runtimePool.query(`DELETE FROM function_triggers WHERE app_id = $1`, [appId]);
    await runtimePool.query(`DELETE FROM app_functions WHERE app_id = $1`, [appId]);
    await runtimePool.query(`DELETE FROM apps WHERE id = $1`, [appId]);

    const [triggers, functions, apps] = await Promise.all([
      runtimePool.query(`SELECT 1 FROM function_triggers WHERE app_id = $1`, [appId]),
      runtimePool.query(`SELECT 1 FROM app_functions WHERE app_id = $1`, [appId]),
      runtimePool.query(`SELECT 1 FROM apps WHERE id = $1`, [appId]),
    ]);
    expect(triggers.rowCount).toBe(0);
    expect(functions.rowCount).toBe(0);
    expect(apps.rowCount).toBe(0);

    await runtimePool.end();
  });

  it('does not throw against the live schema and folds the function_triggers row in', async () => {
    const manifest = await captureAppState(runtimePool, runtimePool, appId);

    expect(manifest.functions).toHaveLength(1);
    const fn = manifest.functions[0];
    expect(fn.name).toBe('on-order-created');
    expect(fn.trigger_type).toBe('cron');
    expect(fn.trigger_config).toEqual({ schedule: '*/5 * * * *' });

    // The runtime pool doubles as the app pool here (see file-level comment);
    // introspectSchema/introspectRls still ran for real and must have
    // returned something shaped like their real contract, not stub output.
    expect(manifest.schema.tables).toBeTypeOf('object');
    expect(Object.keys(manifest.schema.tables).length).toBeGreaterThan(0);
    expect(Array.isArray(manifest.rls)).toBe(true);
    expect(manifest.hashes.functions).toMatch(/^[0-9a-f]{64}$/);
  });

  it('defaults an untriggered function to http/{} rather than throwing', async () => {
    const fnRow = await runtimePool.query<{ id: string }>(
      `INSERT INTO app_functions (app_id, name, code)
       VALUES ($1, 'no-trigger-row', 'export default () => {}')
       RETURNING id`,
      [appId],
    );
    try {
      const manifest = await captureAppState(runtimePool, runtimePool, appId);
      const fn = manifest.functions.find((f) => f.name === 'no-trigger-row');
      expect(fn).toBeDefined();
      expect(fn!.trigger_type).toBe('http');
      expect(fn!.trigger_config).toEqual({});
    } finally {
      await runtimePool.query(`DELETE FROM app_functions WHERE id = $1`, [fnRow.rows[0].id]);
    }
  });
});
