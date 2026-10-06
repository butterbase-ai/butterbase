/**
 * Real-DB coverage for the production/staging usage split.
 *
 * The classification is a JOIN against `app_environments`, not a name pattern,
 * so it has to be exercised against a real database: a mocked pool would let a
 * regression that classified by `name LIKE '%-staging'` — or that dropped the
 * join and called everything production — pass unnoticed.
 *
 * The defect this covers: staging consumed credits against the org meter with
 * no way for a customer to see it separately. `usage_meters.app_id` already
 * carried the attribution; every read path summed it away. A test that would
 * have caught it has to assert the two halves come back DISTINCT, and that
 * they still add up to the org total the customer is billed on.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { getUsageByEnvironment } from './staging-billing-attribution.js';

const RUNTIME_URL =
  process.env.NEON_RUNTIME_PROJECT_ID_US_EAST_1 ??
  'postgresql://butterbase:butterbase_dev@localhost:5437/butterbase_runtime_us';

let runtimeDb: pg.Pool;

const USER = '00000000-0000-0000-0000-0000000000f2';
const ORG = '00000000-0000-0000-0000-0000000000f3';
const OTHER_ORG = '00000000-0000-0000-0000-0000000000f4';

const PROD = 'app_test_sba_prod';
const STAGING = 'app_test_sba_staging';
const PROD_2 = 'app_test_sba_prod2';
const OTHER_ORG_APP = 'app_test_sba_other';
const ALL_APP_IDS = [PROD, STAGING, PROD_2, OTHER_ORG_APP];

const PERIOD = '2026-09-01';
const PERIOD_2 = '2026-09-02';

async function insertApp(id: string, organizationId: string) {
  await runtimeDb.query(
    `INSERT INTO apps (id, name, owner_id, db_name, region, provisioning_status, organization_id)
     VALUES ($1, $1, $2, $1, 'us-east-1', 'ready', $3)
     ON CONFLICT (id) DO UPDATE SET organization_id = EXCLUDED.organization_id`,
    [id, USER, organizationId],
  );
}

async function meter(
  appId: string, organizationId: string, meterType: string, period: string, quantity: number,
) {
  await runtimeDb.query(
    `INSERT INTO usage_meters (user_id, organization_id, app_id, meter_type, period_start, quantity)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id, app_id, meter_type, period_start)
     DO UPDATE SET quantity = EXCLUDED.quantity`,
    [USER, organizationId, appId, meterType, period, quantity],
  );
}

async function cleanup() {
  await runtimeDb.query(`DELETE FROM usage_meters WHERE app_id = ANY($1)`, [ALL_APP_IDS]);
  await runtimeDb.query(
    `DELETE FROM app_environments WHERE prod_app_id = ANY($1) OR staging_app_id = ANY($1)`,
    [ALL_APP_IDS],
  );
  await runtimeDb.query(`DELETE FROM apps WHERE id = ANY($1)`, [ALL_APP_IDS]);
}

function run(start = PERIOD, end = PERIOD_2) {
  return getUsageByEnvironment(
    {} as never, ORG, start, end,
    { regions: ['us-east-1'], runtimePoolForRegion: () => runtimeDb },
  );
}

beforeAll(async () => {
  runtimeDb = new pg.Pool({ connectionString: RUNTIME_URL });
});

afterAll(async () => {
  await cleanup();
  await runtimeDb.end();
});

beforeEach(async () => {
  await cleanup();
  await insertApp(PROD, ORG);
  await insertApp(STAGING, ORG);
  await insertApp(PROD_2, ORG);
  await insertApp(OTHER_ORG_APP, OTHER_ORG);

  await runtimeDb.query(
    `INSERT INTO app_environments (prod_app_id, staging_app_id, created_by)
     VALUES ($1, $2, $3) ON CONFLICT (prod_app_id) DO NOTHING`,
    [PROD, STAGING, USER],
  );

  await meter(PROD, ORG, 'ai_tokens', PERIOD, 1000);
  await meter(PROD_2, ORG, 'ai_tokens', PERIOD, 500);
  await meter(STAGING, ORG, 'ai_tokens', PERIOD, 300);
  await meter(STAGING, ORG, 'ai_tokens', PERIOD_2, 200);
  await meter(PROD, ORG, 'storage_bytes', PERIOD, 4096);
  // Another org's usage must never appear.
  await meter(OTHER_ORG_APP, OTHER_ORG, 'ai_tokens', PERIOD, 999999);
});

describe('getUsageByEnvironment', () => {
  it('reports staging usage separately from production', async () => {
    const out = await run();
    expect(out.totals.production.ai_tokens).toBe(1500);
    expect(out.totals.staging.ai_tokens).toBe(500);
  });

  // The two halves must reconstruct the org total the customer is billed on.
  // A split that quietly loses or double-counts rows is worse than no split.
  it('adds up to the same org total the existing rollups report', async () => {
    const out = await run();
    const total = out.totals.production.ai_tokens + out.totals.staging.ai_tokens;
    const direct = await runtimeDb.query<{ sum: string }>(
      `SELECT COALESCE(SUM(quantity), 0)::bigint AS sum FROM usage_meters
        WHERE organization_id = $1 AND meter_type = 'ai_tokens'
          AND period_start >= $2::date AND period_start <= $3::date`,
      [ORG, PERIOD, PERIOD_2],
    );
    expect(total).toBe(Number.parseInt(direct.rows[0].sum, 10));
  });

  it('never leaks another org\'s usage into either half', async () => {
    const out = await run();
    const everything = [
      ...Object.values(out.totals.production), ...Object.values(out.totals.staging),
    ];
    expect(everything).not.toContain(999999);
  });

  // The classification must come from app_environments, not from a name
  // pattern or an id convention. Dropping the link makes the SAME app read as
  // production — which is the behaviour the join is responsible for.
  it('classifies by the app_environments link, not by name', async () => {
    await runtimeDb.query(`DELETE FROM app_environments WHERE prod_app_id = $1`, [PROD]);
    const out = await run();
    expect(out.totals.staging.ai_tokens).toBeUndefined();
    expect(out.totals.production.ai_tokens).toBe(2000);
    expect(out.stagingAppIds).not.toContain(STAGING);
  });

  it('keeps a per-day series for each environment', async () => {
    const out = await run();
    expect(out.usage.staging.ai_tokens).toEqual([
      { date: PERIOD_2, quantity: 200 },
      { date: PERIOD, quantity: 300 },
    ]);
    expect(out.usage.production.storage_bytes).toEqual([{ date: PERIOD, quantity: 4096 }]);
  });

  it('names the staging app ids that contributed', async () => {
    const out = await run();
    expect(out.stagingAppIds).toContain(STAGING);
    expect(out.stagingAppIds).not.toContain(PROD);
  });

  it('respects the date window', async () => {
    const out = await run(PERIOD_2, PERIOD_2);
    expect(out.totals.staging.ai_tokens).toBe(200);
    expect(out.totals.production.ai_tokens).toBeUndefined();
  });
});
