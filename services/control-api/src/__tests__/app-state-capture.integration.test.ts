import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { publishRelease } from '../services/template-releases.js';

const CONTROL_URL = process.env.CONTROL_DB_URL
  ?? 'postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control';

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
