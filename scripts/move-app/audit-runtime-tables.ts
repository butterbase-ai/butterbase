#!/usr/bin/env tsx
/**
 * Scans every runtime DB and reports each table's app_id status.
 * Output: markdown table per region.
 *
 * Usage:
 *   set -a && . ./.env.e2e && set +a && npx tsx scripts/move-app/audit-runtime-tables.ts
 */
import { runtimePoolFor, listRuntimeRegions } from '../../services/control-api/src/services/runtime-pool-registry.js';

interface TableInfo {
  name: string;
  hasAppId: boolean;
  pkColumns: string[];
}

async function inventory(region: string): Promise<TableInfo[]> {
  const pool = runtimePoolFor(region);
  const r = await pool.query<{ table_name: string; pk: string[] | null; has_app_id: boolean }>(`
    WITH pks AS (
      SELECT i.indrelid::regclass::text AS table_name,
             array_agg(a.attname ORDER BY a.attnum) AS pk
      FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indisprimary
      GROUP BY i.indrelid
    ),
    app_id_cols AS (
      SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'app_id'
    )
    SELECT t.table_name,
           pks.pk,
           (a.table_name IS NOT NULL) AS has_app_id
    FROM information_schema.tables t
    LEFT JOIN pks ON pks.table_name = t.table_name
    LEFT JOIN app_id_cols a ON a.table_name = t.table_name
    WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
    ORDER BY t.table_name
  `);
  return r.rows.map((row) => {
    // pg driver may return array_agg result as a JS array or as a Postgres
    // literal string like "{col1,col2}" depending on query context — normalise.
    let pkColumns: string[] = [];
    if (Array.isArray(row.pk)) {
      pkColumns = row.pk;
    } else if (typeof row.pk === 'string') {
      pkColumns = row.pk.replace(/^\{|\}$/g, '').split(',').filter(Boolean);
    }
    return { name: row.table_name, hasAppId: row.has_app_id, pkColumns };
  });
}

async function main() {
  const regions = listRuntimeRegions();
  console.log(`# Runtime table audit — regions: ${regions.join(', ')}\n`);
  for (const region of regions) {
    const tables = await inventory(region);
    console.log(`## ${region}\n`);
    console.log('| Table | app_id? | PK |');
    console.log('|---|---|---|');
    for (const t of tables) {
      console.log(`| ${t.name} | ${t.hasAppId ? 'YES' : 'no'} | ${t.pkColumns.join(',') || '(none)'} |`);
    }
    console.log('');
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
