/**
 * One-off backfill: rewrite dispatch-worker KV routes for apps that were
 * paused BEFORE the paused-page worker shipped.
 *
 * Those apps still have plain KV values (no `paused` flag), so their
 * frontends keep serving instead of the paused page. This re-syncs every
 * paused WfP app via syncFrontendPausedState, which only rewrites keys that
 * already exist and keeps their appId/region.
 *
 * Run once, after the dispatch worker deploy. Idempotent.
 *
 * Usage: npx tsx scripts/sync-paused-frontends.ts [--dry-run]
 */
import pg from 'pg';
import { config, assertRuntimeDbConfig } from '../src/config.js';
import { getConfiguredRuntimeRegions } from '../src/services/region-resolver.js';
import { getRuntimeDbPool } from '../src/services/runtime-db.js';
import { syncFrontendPausedState } from '../src/services/frontend-pause-sync.js';

const dryRun = process.argv.includes('--dry-run');

async function main() {
  assertRuntimeDbConfig();
  const controlDb = new pg.Pool({ connectionString: config.controlDb.url });
  let found = 0;
  let synced = 0;
  let failed = 0;

  try {
    for (const region of getConfiguredRuntimeRegions()) {
      const pool = getRuntimeDbPool(config.runtimeDb, region);
      const res = await pool.query<{ id: string }>(
        `SELECT id FROM apps WHERE paused AND deployment_backend = 'wfp'`,
      );
      found += res.rows.length;

      for (const { id } of res.rows) {
        if (dryRun) {
          console.log(`[dry-run] ${region} ${id}`);
          continue;
        }
        try {
          const { rewritten } = await syncFrontendPausedState(controlDb, id);
          synced++;
          console.log(`${region} ${id} rewritten=[${rewritten.join(', ')}]`);
        } catch (err) {
          failed++;
          console.error(`${region} ${id} FAILED:`, err instanceof Error ? err.message : err);
        }
      }
    }
  } finally {
    await controlDb.end();
  }

  console.log(
    dryRun
      ? `Dry run: ${found} paused WfP app(s) would be synced.`
      : `Done: ${found} paused WfP app(s) found, ${synced} synced, ${failed} failed.`,
  );
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
