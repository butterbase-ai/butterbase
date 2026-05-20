import type pg from 'pg';
import { MOVE_APP_RUNTIME_TABLES, MOVE_APP_EXCLUDED } from './runtime-tables.js';

const classified = new Set<string>([...MOVE_APP_RUNTIME_TABLES, ...Object.keys(MOVE_APP_EXCLUDED)]);

/**
 * Scan one runtime pool for tables with an app_id column. Throw if any
 * such table is missing from MOVE_APP_RUNTIME_TABLES + MOVE_APP_EXCLUDED.
 */
export async function auditRuntimeTablesForPool(
  pool: pg.Pool | { query: (sql: string, params?: any[]) => Promise<{ rows: any[] }> },
  region: string,
): Promise<void> {
  const r = await pool.query(`
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'app_id'
    GROUP BY table_name
  `);
  const missing = r.rows.map((row: any) => row.table_name).filter((t: string) => !classified.has(t));
  if (missing.length > 0) {
    throw new Error(
      `[runtime-table-audit] ${region}: unclassified per-app tables: ${missing.join(', ')}. ` +
      `Add to MOVE_APP_RUNTIME_TABLES (will be moved) or MOVE_APP_EXCLUDED (will be left behind, with a reason) in ` +
      `services/control-api/src/services/move-app/runtime-tables.ts.`,
    );
  }
}
