/**
 * One-time backfill of app_lineage from existing forks.
 *
 * Existing forks have already diverged, so there is no honest backend base to
 * capture for them — base_fingerprint stays NULL, which means "predates capture".
 * Their repo base IS recoverable from template_clone_jobs.source_snapshot_id, so
 * they still get exact repo divergence.
 *
 * Idempotent: dest_app_id is the primary key and uses ON CONFLICT DO NOTHING,
 * so re-running is safe.
 *
 * Usage: npx tsx scripts/backfill-app-lineage.ts [--dry-run]
 */
import pg from 'pg';
import { config, assertRuntimeDbConfig } from '../src/config.js';
import { getConfiguredRuntimeRegions } from '../src/services/region-resolver.js';
import { getRuntimeDbPool } from '../src/services/runtime-db.js';

const dryRun = process.argv.includes('--dry-run');

async function main() {
  assertRuntimeDbConfig();
  const controlDb = new pg.Pool({ connectionString: config.controlDb.url });
  let found = 0;
  let inserted = 0;

  for (const region of getConfiguredRuntimeRegions()) {
    const pool = getRuntimeDbPool(config.runtimeDb, region);
    const forks = await pool.query<{
      id: string; template_source_app_id: string;
      template_source_region: string | null; created_at: Date;
    }>(
      `SELECT id, template_source_app_id, template_source_region, created_at
         FROM apps
        WHERE template_source_app_id IS NOT NULL`,
    );
    found += forks.rows.length;

    for (const fork of forks.rows) {
      const job = await controlDb.query<{ source_snapshot_id: string; created_at: Date }>(
        `SELECT source_snapshot_id, created_at
           FROM template_clone_jobs
          WHERE dest_app_id = $1
          ORDER BY created_at ASC LIMIT 1`,
        [fork.id],
      );
      const baseSnapshotId = job.rows[0]?.source_snapshot_id ?? null;
      const clonedAt = job.rows[0]?.created_at ?? fork.created_at;

      if (dryRun) {
        console.log(`[dry-run] ${fork.id} <- ${fork.template_source_app_id} (snap=${baseSnapshotId})`);
        continue;
      }

      const res = await controlDb.query(
        `INSERT INTO app_lineage
           (dest_app_id, dest_region, source_app_id, source_region,
            base_release_id, base_fingerprint, base_snapshot_id, cloned_at)
         VALUES ($1, $2, $3, $4, NULL, NULL, $5, $6)
         ON CONFLICT (dest_app_id) DO NOTHING`,
        [fork.id, region, fork.template_source_app_id,
         fork.template_source_region ?? region, baseSnapshotId, clonedAt],
      );
      inserted += res.rowCount ?? 0;
    }
    console.log(`region ${region}: ${forks.rows.length} forks scanned`);
  }

  console.log(`done — ${found} forks found, ${inserted} lineage rows inserted`);
  await controlDb.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
