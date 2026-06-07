import type { StepHandler } from './saga-executor.js';
import {
  MOVE_APP_RUNTIME_TABLES,
  MOVE_APP_RUNTIME_CHILD_TABLES,
  TABLE_PK_OVERRIDES,
} from './runtime-tables.js';

const BATCH = 500;

function pkColumnFor(table: string): string {
  return TABLE_PK_OVERRIDES[table] ?? 'id';
}

async function copyOneTable(
  table: string,
  appId: string,
  migrationId: string,
  sourcePool: any,
  destPool: any,
  log: { info: Function },
): Promise<number> {
  const colRes = await sourcePool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = $1 AND column_name != 'archived_after_move'
     ORDER BY ordinal_position`,
    [table],
  );
  const cols = colRes.rows.map((r: any) => `"${r.column_name}"`).join(', ');
  if (!cols) {
    log.info({ table }, 'runtime table not found on source; skipping');
    return 0;
  }

  const pk = pkColumnFor(table);

  let total = 0;
  let lastKey: any = null;
  while (true) {
    const sql = `SELECT ${cols} FROM "${table}"
      WHERE app_id = $1 AND archived_after_move IS NULL
      ${lastKey ? `AND "${pk}" > $3` : ''}
      ORDER BY "${pk}" ASC
      LIMIT $2`;
    const params: any[] = lastKey ? [appId, BATCH, lastKey] : [appId, BATCH];
    const { rows } = await sourcePool.query(sql, params);
    if (rows.length === 0) break;
    const placeholders = rows
      .map((_: any, i: number) => `(${Object.keys(rows[0]).map((__, j) => `$${i * Object.keys(rows[0]).length + j + 1}`).join(',')})`)
      .join(',');
    const flatParams = rows.flatMap((r: any) => Object.values(r));
    await destPool.query(
      `INSERT INTO "${table}" (${cols}) VALUES ${placeholders} ON CONFLICT ("${pk}") DO NOTHING`,
      flatParams,
    );
    total += rows.length;
    lastKey = rows[rows.length - 1][pk];
    if (rows.length < BATCH) break;
  }
  await sourcePool.query(
    `UPDATE "${table}" SET archived_after_move = $2 WHERE app_id = $1 AND archived_after_move IS NULL`,
    [appId, migrationId],
  );
  return total;
}

/**
 * Copy a child table that doesn't have app_id but FKs into a parent table that
 * does. Filter is `<parent_fk> IN (SELECT id FROM <parent>
 *   WHERE app_id=$1 AND (archived_after_move IS NULL OR archived_after_move=$migration_id))`
 * — the OR catches rows whose parent was already archived earlier in the same
 * migration run (parent tables are copied before children in the same step).
 */
async function copyOneChildTable(
  child: { table: string; parent: string; parent_fk: string },
  appId: string,
  migrationId: string,
  sourcePool: any,
  destPool: any,
  log: { info: Function },
): Promise<number> {
  const { table, parent, parent_fk } = child;
  const colRes = await sourcePool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = $1 AND column_name != 'archived_after_move'
     ORDER BY ordinal_position`,
    [table],
  );
  const cols = colRes.rows.map((r: any) => `"${r.column_name}"`).join(', ');
  if (!cols) {
    log.info({ table }, 'runtime child table not found on source; skipping');
    return 0;
  }

  const pk = pkColumnFor(table);

  let total = 0;
  let lastKey: any = null;
  while (true) {
    const sql = `SELECT ${cols} FROM "${table}"
      WHERE "${parent_fk}" IN (
        SELECT "id" FROM "${parent}"
        WHERE app_id = $1
          AND (archived_after_move IS NULL OR archived_after_move = $2)
      )
      AND archived_after_move IS NULL
      ${lastKey ? `AND "${pk}" > $4` : ''}
      ORDER BY "${pk}" ASC
      LIMIT $3`;
    const params: any[] = lastKey ? [appId, migrationId, BATCH, lastKey] : [appId, migrationId, BATCH];
    const { rows } = await sourcePool.query(sql, params);
    if (rows.length === 0) break;
    const placeholders = rows
      .map((_: any, i: number) => `(${Object.keys(rows[0]).map((__, j) => `$${i * Object.keys(rows[0]).length + j + 1}`).join(',')})`)
      .join(',');
    const flatParams = rows.flatMap((r: any) => Object.values(r));
    await destPool.query(
      `INSERT INTO "${table}" (${cols}) VALUES ${placeholders} ON CONFLICT ("${pk}") DO NOTHING`,
      flatParams,
    );
    total += rows.length;
    lastKey = rows[rows.length - 1][pk];
    if (rows.length < BATCH) break;
  }
  // Archive on source: filter through parent again so we only tag rows that
  // belonged to this app's runs.
  await sourcePool.query(
    `UPDATE "${table}" SET archived_after_move = $2
     WHERE "${parent_fk}" IN (
       SELECT "id" FROM "${parent}"
       WHERE app_id = $1 AND (archived_after_move IS NULL OR archived_after_move = $2)
     )
     AND archived_after_move IS NULL`,
    [appId, migrationId],
  );
  return total;
}

export const executeCopyRuntime: StepHandler = async (ctx, m) => {
  const already: string[] = m.dest_resources.copied_tables ?? [];
  const source = ctx.runtimePoolFor(m.source_region);
  const dest = ctx.runtimePoolFor(m.dest_region);

  const parentTodo = MOVE_APP_RUNTIME_TABLES.filter((t) => !already.includes(t));
  const newlyCopied: string[] = [];
  let rowsTotal = 0;

  for (const table of parentTodo) {
    const n = await copyOneTable(table, m.app_id, m.id, source, dest, ctx.log);
    rowsTotal += n;
    newlyCopied.push(table);
    ctx.log.info({ migrationId: m.id, table, rows: n }, 'runtime table copied');
  }

  // Child tables: copied after parents so the parent rows are present on dest
  // (FK satisfiable) and the parent rows on source carry archived_after_move
  // (so child rows can be filtered through them).
  const childTodo = MOVE_APP_RUNTIME_CHILD_TABLES.filter((c) => !already.includes(c.table));
  for (const child of childTodo) {
    const n = await copyOneChildTable(child, m.app_id, m.id, source, dest, ctx.log);
    rowsTotal += n;
    newlyCopied.push(child.table);
    ctx.log.info({ migrationId: m.id, table: child.table, parent: child.parent, rows: n }, 'runtime child table copied');
  }

  return {
    next: 'flipping_routing',
    patch: { copied_tables: [...already, ...newlyCopied], runtime_rows_copied: (m.dest_resources.runtime_rows_copied ?? 0) + rowsTotal },
  };
};
