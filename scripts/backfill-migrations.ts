/**
 * Runs all data-plane migrations against every app database.
 * Uses the same tracking-aware migrator as app provisioning,
 * so only unapplied migrations are executed.
 *
 * Neon pooler endpoints remap the role (e.g. neondb_owner → butterbase_service),
 * which lacks CREATE on public. This script converts pooler URLs to direct
 * endpoints so the connection authenticates as the real neondb_owner.
 *
 * Usage:
 *   CONTROL_DB_URL=postgresql://... npx tsx scripts/backfill-migrations.ts
 *   CONTROL_DB_URL=postgresql://... npx tsx scripts/backfill-migrations.ts app_abc123
 *
 * Parallelism: migrations run concurrently (parallel I/O). Override with
 *   BACKFILL_MIGRATION_CONCURRENCY=8
 */
import os from 'node:os';
import pg from 'pg';
import { runDataPlaneMigrations } from '../services/control-api/src/services/migrator.js';

// Phase 2: single-region — app_db_connections is a runtime table.
// When multi-region lands, accept a --region flag and derive per-region URLs.
const runtimeDbUrl =
  process.env.NEON_RUNTIME_PROJECT_ID_US_EAST_1 ??
  process.env.CONTROL_DB_URL ??
  'postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control';

const targetAppId = process.argv[2];

/**
 * Convert a Neon pooler connection string to a direct endpoint.
 * Pooler: ep-quiet-grass-anw91vb4-pooler.c-6.us-east-1.aws.neon.tech:5432
 * Direct: ep-quiet-grass-anw91vb4.c-6.us-east-1.aws.neon.tech:5432
 */
function toDirectEndpoint(connectionString: string): string {
  return connectionString.replace(/-pooler\./, '.');
}

const DEFAULT_CONCURRENCY = Math.min(8, os.availableParallelism?.() ?? 4);

function migrationConcurrency(): number {
  const raw = process.env.BACKFILL_MIGRATION_CONCURRENCY;
  if (raw) {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 1) return n;
  }
  return DEFAULT_CONCURRENCY;
}

/**
 * Run tasks over `items` with at most `limit` in flight at once.
 */
async function runPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  if (items.length === 0) return [];
  const results: R[] = new Array(items.length);
  const workers = Math.min(limit, items.length);
  let next = 0;

  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  }

  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

async function main() {
  // app_db_connections is a runtime table — use the runtime DB pool.
  const controlPool = new pg.Pool({ connectionString: runtimeDbUrl, max: 2 });

  try {
    const query = targetAppId
      ? {
          text: `SELECT app_id, connection_string FROM app_db_connections WHERE app_id = $1`,
          values: [targetAppId],
        }
      : {
          text: `SELECT app_id, connection_string FROM app_db_connections`,
        };
    const { rows } = await controlPool.query<{
      app_id: string;
      connection_string: string;
    }>(query);

    const concurrency = migrationConcurrency();
    console.log(`Found ${rows.length} app database(s) (concurrency: ${concurrency}).\n`);

    const outcomes = await runPool(rows, concurrency, async (row) => {
      try {
        const connStr = toDirectEndpoint(row.connection_string);
        await runDataPlaneMigrations(connStr);
        return { ok: true as const, appId: row.app_id };
      } catch (err: any) {
        return { ok: false as const, appId: row.app_id, message: err.message as string };
      }
    });

    let success = 0;
    let failed = 0;
    for (const o of outcomes) {
      if (o.ok) {
        console.log(`  [OK]   ${o.appId}`);
        success++;
      } else {
        console.error(`  [FAIL] ${o.appId}: ${o.message}`);
        failed++;
      }
    }

    console.log(`\nDone. ${success} succeeded, ${failed} failed.`);
    if (failed > 0) process.exit(1);
  } finally {
    await controlPool.end();
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
