/**
 * Unit tests for the fork_count decrement sweeper.
 *
 * Connects to the local control-plane DB and a local runtime DB (single-region
 * local setup — the test uses the same DB for "source" runtime to keep the
 * fixture self-contained).
 *
 * Run with:
 *   npx vitest run services/control-api/src/services/fork-count-sweeper.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { runOnce, startForkCountSweeper } from './fork-count-sweeper.js';
import { _resetRuntimeDbPools } from './runtime-db.js';

// ── DB connection strings ───────────────────────────────────────────────────
const CONTROL_URL =
  process.env.NEON_PLATFORM_PRIMARY_URL ??
  'postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control';

// The local US runtime DB doubles as the "source" runtime region DB in tests.
// Port 5437 is the local docker-compose mapping for runtime-plane-db.
const RUNTIME_URL =
  process.env.NEON_RUNTIME_PROJECT_ID_US_EAST_1 ??
  'postgresql://butterbase:butterbase_dev@localhost:5437/butterbase_runtime_us';

const TEST_REGION = 'us-east-1';

// ── Pools ───────────────────────────────────────────────────────────────────
let controlDb: pg.Pool;
let runtimeDb: pg.Pool;

// ── Test fixtures ────────────────────────────────────────────────────────────
let sourceAppId: string;

// Silent logger for tests.
const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const runtimeDbConfig = { urlsByRegion: { [TEST_REGION]: RUNTIME_URL } };

// ── Lifecycle ────────────────────────────────────────────────────────────────

beforeAll(async () => {
  controlDb = new pg.Pool({ connectionString: CONTROL_URL });
  runtimeDb = new pg.Pool({ connectionString: RUNTIME_URL });

  // Seed a source app row with fork_count = 5 in the runtime DB.
  // apps.id is text with no default — supply a stable test ID.
  sourceAppId = 'sweep-test-src-app-001';
  await runtimeDb.query(
    `INSERT INTO apps (id, name, subdomain, db_name, owner_id, fork_count)
     VALUES ($1, 'sweeper-test-source', 'sweeper-test-src', 'sweeper_test_db',
             '00000000-0000-0000-0000-000000000001', 5)
     ON CONFLICT (id) DO UPDATE SET fork_count = 5`,
    [sourceAppId],
  );
});

afterAll(async () => {
  // Clean up all test rows.
  await controlDb
    .query(`DELETE FROM fork_count_decrements WHERE source_app_id = $1`, [sourceAppId])
    .catch(() => {});
  await runtimeDb
    .query(`DELETE FROM apps WHERE id = $1`, [sourceAppId])
    .catch(() => {});
  _resetRuntimeDbPools();
  await controlDb.end();
  await runtimeDb.end();
});

beforeEach(async () => {
  // Wipe any leftover decrement rows between tests and reset fork_count to 5.
  await controlDb.query(`DELETE FROM fork_count_decrements WHERE source_app_id = $1`, [sourceAppId]);
  await runtimeDb.query(`UPDATE apps SET fork_count = 5 WHERE id = $1`, [sourceAppId]);
  _resetRuntimeDbPools();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('runOnce (fork-count-sweeper)', () => {
  it('debits source.fork_count and marks the row processed', async () => {
    // Insert a pending decrement row.
    const ins = await controlDb.query<{ id: string }>(
      `INSERT INTO fork_count_decrements (source_app_id, source_region)
       VALUES ($1, $2) RETURNING id`,
      [sourceAppId, TEST_REGION],
    );
    const decrementId = ins.rows[0].id;

    await runOnce(controlDb, runtimeDbConfig, logger);

    // fork_count should have dropped from 5 → 4.
    const app = await runtimeDb.query<{ fork_count: number }>(
      `SELECT fork_count FROM apps WHERE id = $1`,
      [sourceAppId],
    );
    expect(app.rows[0].fork_count).toBe(4);

    // The outbox row should be marked processed.
    const dec = await controlDb.query<{ processed_at: Date | null }>(
      `SELECT processed_at FROM fork_count_decrements WHERE id = $1`,
      [decrementId],
    );
    expect(dec.rows[0].processed_at).not.toBeNull();
  });

  it('skips already-processed rows', async () => {
    // Insert a row that is already processed.
    await controlDb.query(
      `INSERT INTO fork_count_decrements (source_app_id, source_region, processed_at)
       VALUES ($1, $2, now())`,
      [sourceAppId, TEST_REGION],
    );

    await runOnce(controlDb, runtimeDbConfig, logger);

    // fork_count must remain at 5 — already-processed rows are ignored.
    const app = await runtimeDb.query<{ fork_count: number }>(
      `SELECT fork_count FROM apps WHERE id = $1`,
      [sourceAppId],
    );
    expect(app.rows[0].fork_count).toBe(5);
  });

  it('does not allow fork_count to go below 0', async () => {
    // Set fork_count to 0 first.
    await runtimeDb.query(`UPDATE apps SET fork_count = 0 WHERE id = $1`, [sourceAppId]);

    await controlDb.query(
      `INSERT INTO fork_count_decrements (source_app_id, source_region) VALUES ($1, $2)`,
      [sourceAppId, TEST_REGION],
    );

    await runOnce(controlDb, runtimeDbConfig, logger);

    const app = await runtimeDb.query<{ fork_count: number }>(
      `SELECT fork_count FROM apps WHERE id = $1`,
      [sourceAppId],
    );
    // GREATEST(0, 0 - 1) = 0.
    expect(app.rows[0].fork_count).toBe(0);
  });

  it('processes multiple rows in a single tick', async () => {
    // Insert three decrement rows.
    for (let i = 0; i < 3; i++) {
      await controlDb.query(
        `INSERT INTO fork_count_decrements (source_app_id, source_region) VALUES ($1, $2)`,
        [sourceAppId, TEST_REGION],
      );
    }

    await runOnce(controlDb, runtimeDbConfig, logger);

    // fork_count should drop from 5 → 2.
    const app = await runtimeDb.query<{ fork_count: number }>(
      `SELECT fork_count FROM apps WHERE id = $1`,
      [sourceAppId],
    );
    expect(app.rows[0].fork_count).toBe(2);

    // All three rows should be processed.
    const remaining = await controlDb.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM fork_count_decrements
       WHERE source_app_id = $1 AND processed_at IS NULL`,
      [sourceAppId],
    );
    expect(remaining.rows[0].c).toBe(0);
  });
});

describe('startForkCountSweeper (lifecycle)', () => {
  it('starts and stops cleanly with no rows to process', async () => {
    const handle = startForkCountSweeper(controlDb, runtimeDbConfig, logger, 50);
    // Give one tick time to run.
    await new Promise((res) => setTimeout(res, 80));
    await handle.stop();

    // fork_count should still be 5 — nothing to process.
    const app = await runtimeDb.query<{ fork_count: number }>(
      `SELECT fork_count FROM apps WHERE id = $1`,
      [sourceAppId],
    );
    expect(app.rows[0].fork_count).toBe(5);
  });

  it('processes a row inserted before the sweeper starts', async () => {
    await controlDb.query(
      `INSERT INTO fork_count_decrements (source_app_id, source_region) VALUES ($1, $2)`,
      [sourceAppId, TEST_REGION],
    );

    const handle = startForkCountSweeper(controlDb, runtimeDbConfig, logger, 50);
    // Wait long enough for at least one tick.
    await new Promise((res) => setTimeout(res, 120));
    await handle.stop();

    const app = await runtimeDb.query<{ fork_count: number }>(
      `SELECT fork_count FROM apps WHERE id = $1`,
      [sourceAppId],
    );
    expect(app.rows[0].fork_count).toBe(4);
  });
});
