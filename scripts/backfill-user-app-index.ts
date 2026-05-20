#!/usr/bin/env tsx
/**
 * Reads every apps row from every regional runtime DB and inserts a matching
 * user_app_index row in the platform DB. Idempotent (ON CONFLICT DO NOTHING).
 *
 * Usage:
 *   tsx scripts/backfill-user-app-index.ts --dry-run
 *   tsx scripts/backfill-user-app-index.ts
 */
import pg from 'pg';

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  const platformUrl = process.env.NEON_PLATFORM_PRIMARY_URL;
  if (!platformUrl) throw new Error('NEON_PLATFORM_PRIMARY_URL required');
  const platform = new pg.Pool({ connectionString: platformUrl });

  const regions = (process.env.BUTTERBASE_REGIONS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  let total = 0;

  try {
    for (const region of regions) {
      const url = process.env[`NEON_RUNTIME_PROJECT_ID_${region.toUpperCase().replace(/-/g, '_')}`];
      if (!url) continue;
      const runtime = new pg.Pool({ connectionString: url });
      try {
        const { rows } = await runtime.query<{ id: string; owner_id: string; subdomain: string | null; name: string | null }>(
          `SELECT id, owner_id, subdomain, name FROM apps WHERE region = $1`,
          [region],
        );
        console.log(`[backfill-user-app-index] region=${region}: ${rows.length} apps`);
        for (const row of rows) {
          if (DRY_RUN) {
            console.log(`  [dry] add ${row.id} for ${row.owner_id} in ${region}`);
          } else {
            await platform.query(
              `INSERT INTO user_app_index (app_id, user_id, region, subdomain, app_name)
               VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (app_id) DO UPDATE
               SET region = EXCLUDED.region,
                   subdomain = EXCLUDED.subdomain,
                   app_name = EXCLUDED.app_name,
                   updated_at = now()`,
              [row.id, row.owner_id, region, row.subdomain, row.name],
            );
            total++;
          }
        }
      } finally {
        await runtime.end();
      }
    }
  } finally {
    await platform.end();
  }
  console.log(`[backfill-user-app-index] inserted/updated ${total} rows`);
}

main().catch((e) => { console.error(e); process.exit(1); });
