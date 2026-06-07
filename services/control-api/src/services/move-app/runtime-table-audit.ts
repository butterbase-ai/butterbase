import type pg from 'pg';
import {
  MOVE_APP_RUNTIME_TABLES,
  MOVE_APP_RUNTIME_CHILD_TABLES,
  MOVE_APP_EXCLUDED,
  MOVE_APP_EXCLUDED_CHILD,
} from './runtime-tables.js';

const classifiedParents = new Set<string>([
  ...MOVE_APP_RUNTIME_TABLES,
  ...Object.keys(MOVE_APP_EXCLUDED),
]);
const classifiedChildren = new Set<string>([
  ...MOVE_APP_RUNTIME_CHILD_TABLES.map((c) => c.table),
  ...Object.keys(MOVE_APP_EXCLUDED_CHILD),
]);
const registeredParentNames = new Set<string>(MOVE_APP_RUNTIME_TABLES);

/**
 * Scan one runtime pool for:
 *   (1) tables with an app_id column — must be in MOVE_APP_RUNTIME_TABLES or
 *       MOVE_APP_EXCLUDED, AND
 *   (2) tables with a foreign key to a registered parent's PK — must be in
 *       MOVE_APP_RUNTIME_CHILD_TABLES or MOVE_APP_EXCLUDED_CHILD.
 *
 * (2) catches the class of bug where a child table (e.g. agent_run_events)
 * lives downstream of a per-app parent and would be silently dropped by the
 * move-app saga if not registered.
 */
export async function auditRuntimeTablesForPool(
  pool: pg.Pool | { query: (sql: string, params?: any[]) => Promise<{ rows: any[] }> },
  region: string,
): Promise<void> {
  // (1) Tables with app_id.
  const appIdTables = await pool.query(`
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'app_id'
    GROUP BY table_name
  `);
  const missingParents = appIdTables.rows
    .map((row: any) => row.table_name)
    .filter((t: string) => !classifiedParents.has(t));
  if (missingParents.length > 0) {
    throw new Error(
      `[runtime-table-audit] ${region}: unclassified per-app tables: ${missingParents.join(', ')}. ` +
      `Add to MOVE_APP_RUNTIME_TABLES (will be moved) or MOVE_APP_EXCLUDED (will be left behind, with a reason) in ` +
      `services/control-api/src/services/move-app/runtime-tables.ts.`,
    );
  }

  // (2) Tables that FK to a registered parent's PK but aren't themselves
  // app_id-bearing (those are already caught above as parents). The FK target
  // table check uses pg_catalog.pg_constraint for accuracy.
  const fkChildren = await pool.query(`
    SELECT DISTINCT
      c.conrelid::regclass::text AS child_table,
      c.confrelid::regclass::text AS parent_table
    FROM pg_catalog.pg_constraint c
    JOIN pg_catalog.pg_namespace ns_child  ON ns_child.oid  = (SELECT relnamespace FROM pg_class WHERE oid = c.conrelid)
    JOIN pg_catalog.pg_namespace ns_parent ON ns_parent.oid = (SELECT relnamespace FROM pg_class WHERE oid = c.confrelid)
    WHERE c.contype = 'f'
      AND ns_child.nspname  = 'public'
      AND ns_parent.nspname = 'public'
  `);
  const missingChildren: string[] = [];
  for (const row of fkChildren.rows as Array<{ child_table: string; parent_table: string }>) {
    if (!registeredParentNames.has(row.parent_table)) continue;
    // Skip if the child table itself has app_id — it's classified as a parent.
    if (classifiedParents.has(row.child_table)) continue;
    if (classifiedChildren.has(row.child_table)) continue;
    missingChildren.push(`${row.child_table} (→ ${row.parent_table})`);
  }
  if (missingChildren.length > 0) {
    const unique = Array.from(new Set(missingChildren));
    throw new Error(
      `[runtime-table-audit] ${region}: unclassified per-app child tables (FK to a moved parent): ${unique.join(', ')}. ` +
      `Add to MOVE_APP_RUNTIME_CHILD_TABLES (will be moved through the parent's app_id) or MOVE_APP_EXCLUDED_CHILD ` +
      `(will be left behind, with a reason) in services/control-api/src/services/move-app/runtime-tables.ts.`,
    );
  }
}
