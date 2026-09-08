/**
 * Real-DB coverage for staging-reaper.ts's safety property: "this sweeper
 * cannot take a customer's live production site offline."
 *
 * The mock-based tests in staging-reaper.test.ts (following the brief) prove
 * the code SHAPE is right — a query is issued, its text mentions the right
 * tables — but a fully-mocked DB can never contain a production app for the
 * WHERE clause to wrongly match, so it cannot catch a regression in the
 * predicate itself (an OR where an AND belongs, a widened join, a dropped
 * clause). This file follows app-environments.test.ts's pattern (Task 1) —
 * real fixtures against the real runtime-plane Postgres, cleaned up in
 * afterAll — to close that gap.
 *
 * Run with:
 *   npx vitest run services/control-api/src/services/staging-reaper-integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { findIdleStagingApps, runOnce } from './staging-reaper.js';

const RUNTIME_URL =
  process.env.NEON_RUNTIME_PROJECT_ID_US_EAST_1 ??
  'postgresql://butterbase:butterbase_dev@localhost:5437/butterbase_runtime_us';

let runtimeDb: pg.Pool;
const USER = '00000000-0000-0000-0000-0000000000e2';

// One prod/staging pair per scenario so a wrong predicate in one scenario
// cannot be masked by a correct one in another.
const PROD = 'app_test_reaper_prod';
const STAGING_IDLE = 'app_test_reaper_staging_idle';
const STAGING_FRESH_PROD = 'app_test_reaper_prod2';
const STAGING_FRESH = 'app_test_reaper_staging_fresh';
const STAGING_PAUSED_PROD = 'app_test_reaper_prod3';
const STAGING_PAUSED = 'app_test_reaper_staging_paused';
const ORPHAN_IDLE = 'app_test_reaper_orphan_idle';

const ALL_APP_IDS = [
  PROD, STAGING_IDLE,
  STAGING_FRESH_PROD, STAGING_FRESH,
  STAGING_PAUSED_PROD, STAGING_PAUSED,
  ORPHAN_IDLE,
];

const IDLE_DAYS = 30;
const OLD = () => new Date(Date.now() - (IDLE_DAYS + 5) * 24 * 60 * 60 * 1000); // well past idle
const RECENT = () => new Date(Date.now() - 1 * 24 * 60 * 60 * 1000); // 1 day old, well within idle

async function insertApp(id: string, opts: { updatedAt: Date; paused?: boolean }) {
  await runtimeDb.query(
    `INSERT INTO apps (id, name, owner_id, db_name, region, updated_at, paused)
     VALUES ($1, $1, $2, $1, 'us-east-1', $3, $4)
     ON CONFLICT (id) DO UPDATE SET updated_at = EXCLUDED.updated_at, paused = EXCLUDED.paused`,
    [id, USER, opts.updatedAt, opts.paused ?? false],
  );
}

async function linkAppEnvironment(prodAppId: string, stagingAppId: string, timestamp: Date) {
  await runtimeDb.query(
    `INSERT INTO app_environments (prod_app_id, staging_app_id, created_by, created_at, last_reset_at)
     VALUES ($1, $2, $3, $4, $4)
     ON CONFLICT (prod_app_id) DO UPDATE
       SET staging_app_id = EXCLUDED.staging_app_id,
           created_at = EXCLUDED.created_at,
           last_reset_at = EXCLUDED.last_reset_at`,
    [prodAppId, stagingAppId, USER, timestamp],
  );
}

async function isPaused(id: string): Promise<boolean> {
  const res = await runtimeDb.query<{ paused: boolean }>(`SELECT paused FROM apps WHERE id = $1`, [id]);
  return res.rows[0]?.paused ?? false;
}

const logger = { info: () => {}, warn: () => {}, error: () => {} };

beforeAll(async () => {
  runtimeDb = new pg.Pool({ connectionString: RUNTIME_URL });
});

afterAll(async () => {
  await runtimeDb.query(`DELETE FROM app_environments WHERE prod_app_id = ANY($1)`, [ALL_APP_IDS]);
  await runtimeDb.query(`DELETE FROM apps WHERE id = ANY($1)`, [ALL_APP_IDS]);
  await runtimeDb.end();
});

beforeEach(async () => {
  // Reset fixtures to a known state before every test, since tests mutate
  // `paused` via runOnce.
  await insertApp(PROD, { updatedAt: RECENT() });
  await insertApp(STAGING_IDLE, { updatedAt: OLD() });
  await linkAppEnvironment(PROD, STAGING_IDLE, OLD());

  await insertApp(STAGING_FRESH_PROD, { updatedAt: RECENT() });
  await insertApp(STAGING_FRESH, { updatedAt: RECENT() });
  await linkAppEnvironment(STAGING_FRESH_PROD, STAGING_FRESH, RECENT());

  await insertApp(STAGING_PAUSED_PROD, { updatedAt: RECENT() });
  await insertApp(STAGING_PAUSED, { updatedAt: OLD(), paused: true });
  await linkAppEnvironment(STAGING_PAUSED_PROD, STAGING_PAUSED, OLD());

  // Idle, but never linked into app_environments at all — not anyone's
  // staging app.
  await insertApp(ORPHAN_IDLE, { updatedAt: OLD() });
});

describe('staging-reaper — real-DB safety property', () => {
  it('pauses the idle staging app but never the linked production app', async () => {
    const result = await runOnce(runtimeDb, IDLE_DAYS, logger);
    expect(result.paused).toBeGreaterThanOrEqual(1);

    expect(await isPaused(STAGING_IDLE)).toBe(true);
    expect(await isPaused(PROD)).toBe(false);
  });

  it('leaves an idle app alone when it is not in app_environments at all', async () => {
    await runOnce(runtimeDb, IDLE_DAYS, logger);
    expect(await isPaused(ORPHAN_IDLE)).toBe(false);
  });

  it('leaves a staging app alone when it is not idle yet (real date predicate)', async () => {
    const ids = await findIdleStagingApps(runtimeDb, IDLE_DAYS);
    expect(ids).not.toContain(STAGING_FRESH);

    await runOnce(runtimeDb, IDLE_DAYS, logger);
    expect(await isPaused(STAGING_FRESH)).toBe(false);
  });

  it('does not include an already-paused staging app as a reap candidate (idempotent, no-op)', async () => {
    const ids = await findIdleStagingApps(runtimeDb, IDLE_DAYS);
    expect(ids).not.toContain(STAGING_PAUSED);

    await runOnce(runtimeDb, IDLE_DAYS, logger);
    // Still paused — the sweep neither un-pauses it nor errors on it.
    expect(await isPaused(STAGING_PAUSED)).toBe(true);
  });

  it('findIdleStagingApps returns exactly the idle staging app id, scoped through app_environments', async () => {
    const ids = await findIdleStagingApps(runtimeDb, IDLE_DAYS);
    expect(ids).toContain(STAGING_IDLE);
    expect(ids).not.toContain(PROD);
    expect(ids).not.toContain(ORPHAN_IDLE);
    expect(ids).not.toContain(STAGING_FRESH);
    expect(ids).not.toContain(STAGING_PAUSED);
  });
});
