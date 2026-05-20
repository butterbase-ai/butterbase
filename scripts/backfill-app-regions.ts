#!/usr/bin/env tsx
/**
 * Audits apps.region across every runtime DB and reports rows that don't match
 * the runtime DB's intended region. With --fix, sets region to the runtime DB's
 * region (the runtime DB itself is single-region, so any apps row in it should
 * carry that region).
 *
 * Usage:
 *   tsx scripts/backfill-app-regions.ts --dry-run
 *   tsx scripts/backfill-app-regions.ts --fix
 */
import pg from 'pg';

const FIX = process.argv.includes('--fix');

async function main() {
  const regions = (process.env.BUTTERBASE_REGIONS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (regions.length === 0) throw new Error('BUTTERBASE_REGIONS is empty');

  for (const region of regions) {
    const url = process.env[`NEON_RUNTIME_PROJECT_ID_${region.toUpperCase().replace(/-/g, '_')}`];
    if (!url) {
      console.warn(`[backfill-app-regions] region ${region}: no NEON_RUNTIME_PROJECT_ID_*; skipping`);
      continue;
    }
    const pool = new pg.Pool({ connectionString: url });
    try {
      const { rows } = await pool.query<{ id: string; region: string }>(
        `SELECT id, region FROM apps WHERE region != $1`,
        [region],
      );
      console.log(`[backfill-app-regions] region=${region}: ${rows.length} apps with wrong region`);
      for (const row of rows) {
        console.log(`  app ${row.id} has region=${row.region}, should be ${region}`);
        if (FIX) {
          await pool.query(`UPDATE apps SET region = $1 WHERE id = $2`, [region, row.id]);
        }
      }
    } finally {
      await pool.end();
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
