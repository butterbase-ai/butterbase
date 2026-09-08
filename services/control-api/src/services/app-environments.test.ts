/**
 * Run with:
 *   npx vitest run services/control-api/src/services/app-environments.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import {
  linkEnvironments, getEnvironmentLink, getLinkByStagingApp,
  unlinkEnvironment, touchEnvironmentTimestamp,
} from './app-environments.js';

const RUNTIME_URL =
  process.env.NEON_RUNTIME_PROJECT_ID_US_EAST_1 ??
  'postgresql://butterbase:butterbase_dev@localhost:5437/butterbase_runtime_us';

let runtimeDb: pg.Pool;
const PROD = 'app_test_env_prod';
const STAGING = 'app_test_env_staging';
const PROD_OTHER = 'app_test_env_prod_other';
const USER = '00000000-0000-0000-0000-0000000000e1';

async function insertApp(id: string) {
  await runtimeDb.query(
    `INSERT INTO apps (id, name, owner_id, db_name, region)
     VALUES ($1, $1, $2, $1, 'us-east-1') ON CONFLICT (id) DO NOTHING`,
    [id, USER],
  );
}

beforeAll(async () => {
  runtimeDb = new pg.Pool({ connectionString: RUNTIME_URL });
  await insertApp(PROD);
  await insertApp(STAGING);
  await insertApp(PROD_OTHER);
});

afterAll(async () => {
  await runtimeDb.query(`DELETE FROM apps WHERE id = ANY($1)`, [[PROD, STAGING, PROD_OTHER]]);
  await runtimeDb.end();
});

beforeEach(async () => {
  await runtimeDb.query(
    `DELETE FROM app_environments WHERE prod_app_id = ANY($1)`, [[PROD, PROD_OTHER]],
  );
});

describe('app-environments', () => {
  it('links a pair and reads it back from both directions', async () => {
    const link = await linkEnvironments(runtimeDb, {
      prodAppId: PROD, stagingAppId: STAGING, createdBy: USER,
    });
    expect(link.prod_app_id).toBe(PROD);
    expect(link.staging_app_id).toBe(STAGING);
    expect(link.last_promoted_at).toBeNull();

    expect((await getEnvironmentLink(runtimeDb, PROD))?.staging_app_id).toBe(STAGING);
    expect((await getLinkByStagingApp(runtimeDb, STAGING))?.prod_app_id).toBe(PROD);
  });

  it('returns null for an app with no staging environment', async () => {
    expect(await getEnvironmentLink(runtimeDb, PROD)).toBeNull();
  });

  it('refuses a second staging environment for the same production app', async () => {
    await linkEnvironments(runtimeDb, { prodAppId: PROD, stagingAppId: STAGING, createdBy: USER });
    await expect(
      linkEnvironments(runtimeDb, { prodAppId: PROD, stagingAppId: PROD, createdBy: USER }),
    ).rejects.toThrow();
  });

  it('is idempotent for the identical pair (resumed clone job retry)', async () => {
    const first = await linkEnvironments(runtimeDb, {
      prodAppId: PROD, stagingAppId: STAGING, createdBy: USER,
    });
    const second = await linkEnvironments(runtimeDb, {
      prodAppId: PROD, stagingAppId: STAGING, createdBy: USER,
    });
    expect(second.prod_app_id).toBe(first.prod_app_id);
    expect(second.staging_app_id).toBe(STAGING);

    const rows = await runtimeDb.query(
      `SELECT count(*)::int AS n FROM app_environments WHERE prod_app_id = $1`, [PROD],
    );
    expect(rows.rows[0].n).toBe(1);
  });

  it('refuses linking a staging app that already serves a different production app', async () => {
    await linkEnvironments(runtimeDb, { prodAppId: PROD, stagingAppId: STAGING, createdBy: USER });
    await expect(
      linkEnvironments(runtimeDb, { prodAppId: PROD_OTHER, stagingAppId: STAGING, createdBy: USER }),
    ).rejects.toThrow();
  });

  it('touches the last_promoted_at timestamp column', async () => {
    await linkEnvironments(runtimeDb, { prodAppId: PROD, stagingAppId: STAGING, createdBy: USER });
    await touchEnvironmentTimestamp(runtimeDb, PROD, 'last_promoted_at');
    const link = await getEnvironmentLink(runtimeDb, PROD);
    expect(link?.last_promoted_at).toBeInstanceOf(Date);
    expect(link?.last_reset_at).toBeNull();
  });

  it('touches the last_reset_at timestamp column', async () => {
    await linkEnvironments(runtimeDb, { prodAppId: PROD, stagingAppId: STAGING, createdBy: USER });
    await touchEnvironmentTimestamp(runtimeDb, PROD, 'last_reset_at');
    const link = await getEnvironmentLink(runtimeDb, PROD);
    expect(link?.last_reset_at).toBeInstanceOf(Date);
    expect(link?.last_promoted_at).toBeNull();
  });

  it('unlinks', async () => {
    await linkEnvironments(runtimeDb, { prodAppId: PROD, stagingAppId: STAGING, createdBy: USER });
    await unlinkEnvironment(runtimeDb, PROD);
    expect(await getEnvironmentLink(runtimeDb, PROD)).toBeNull();
  });
});
