/**
 * Schema replay for clone jobs.
 *
 * Reads the source app's schema via introspection, diffs it against an empty
 * current schema, and applies the resulting DDL to the destination app's DB.
 * Idempotent: applyMigration is a diff-apply, so if it ran partially on a
 * prior attempt the next call will only apply what's still missing.
 */

import type pg from 'pg';
import { introspectSchema } from './schema-introspector.js';
import { diffSchema } from './schema-differ.js';
import { applyMigration } from './schema-applier.js';
import type { SchemaDSL } from './schema-validator.js';
import { introspectRls } from './rls-introspector.js';

export interface ReplayLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
}

/**
 * Replay the source app's schema onto the dest app's database.
 *
 * @param sourceAppPool - Connected pool for the source app's per-app DB.
 * @param destAppPool   - Connected pool for the dest app's per-app DB.
 * @param destAppId     - Dest app ID (used in the migration log name only).
 * @param logger        - Logger compatible with pino's info/warn interface.
 */
export async function replaySchema(
  sourceAppPool: pg.Pool,
  destAppPool: pg.Pool,
  destAppId: string,
  logger: ReplayLogger,
): Promise<void> {
  // 1. Introspect the source app's current schema.
  const sourceDsl = await introspectSchema(sourceAppPool);

  const tableCount = Object.keys(sourceDsl.tables).length;
  if (tableCount === 0) {
    logger.info({ destAppId }, '[clone] source has no user tables; skipping schema replay');
    return;
  }

  // 2. Diff against an empty dest schema so every source table becomes a CREATE.
  //    IntrospectedSchema and SchemaDSL share compatible column-info shapes;
  //    cast is safe because diffSchema only reads the common fields.
  const emptyCurrentSchema = { tables: {} };
  const statements = diffSchema(emptyCurrentSchema, sourceDsl as unknown as SchemaDSL);

  if (statements.length === 0) {
    logger.info({ destAppId }, '[clone] diff produced no statements; skipping schema replay');
    return;
  }

  // 3. Apply the statements to the dest DB.
  await applyMigration(destAppPool, statements, 'clone-replay-schema');

  logger.info(
    { destAppId, tableCount, statementCount: statements.length },
    '[clone] schema replayed',
  );
}

// ---------------------------------------------------------------------------
// replaySeedData
// ---------------------------------------------------------------------------

const SEED_BATCH_SIZE = 500;

/**
 * Copy rows from every seed-flagged table on the source DB into the matching
 * table on the dest DB.
 *
 * Seed-flagged tables are recorded in the source's `_seed_tables` registry
 * (populated by Phase 4d's schema-applier when `_seed: true` is set on a
 * table).  Apps that pre-date the bootstrap won't have `_seed_tables` at all;
 * in that case the function returns immediately with an empty result
 * (forward-compat / soft-fail).
 *
 * Per-table soft-fail: a constraint / column-mismatch error on INSERT is
 * recorded as a warning and the copy continues with the next table.
 *
 * @param sourceAppPool - Connected pool for the source app's per-app DB.
 * @param destAppPool   - Connected pool for the dest app's per-app DB.
 * @param logger        - Logger compatible with pino's info/warn interface.
 * @returns `{ tables, rows, warnings }` — tables successfully copied, total
 *          rows inserted, and any per-table warning strings.
 */
export async function replaySeedData(
  sourceAppPool: pg.Pool,
  destAppPool: pg.Pool,
  logger: ReplayLogger,
): Promise<{ tables: string[]; rows: number; warnings: string[] }> {
  let flagged;
  try {
    flagged = await sourceAppPool.query<{ name: string }>(`SELECT name FROM _seed_tables`);
  } catch (err) {
    // Forward-compat: apps pre-dating the _seed_tables bootstrap don't have it.
    logger.warn({ err }, '[clone] _seed_tables missing on source; no seed copy');
    return { tables: [], rows: 0, warnings: [] };
  }
  const warnings: string[] = [];
  let totalRows = 0;
  const tablesCopied: string[] = [];
  for (const row of flagged.rows) {
    const table = row.name;
    const cols = await sourceAppPool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`,
      [table],
    );
    if (cols.rows.length === 0) {
      warnings.push(`Seed table ${table} flagged but has no columns; skipping`);
      continue;
    }
    const colList = cols.rows.map(c => `"${c.column_name}"`).join(', ');
    let offset = 0;
    while (true) {
      const batch = await sourceAppPool.query(
        `SELECT ${colList} FROM "${table}" ORDER BY 1 OFFSET ${offset} LIMIT ${SEED_BATCH_SIZE}`,
      );
      if (batch.rows.length === 0) break;
      const placeholders: string[] = [];
      const values: unknown[] = [];
      let i = 1;
      for (const r of batch.rows) {
        const rowPh = cols.rows.map(() => `$${i++}`);
        placeholders.push(`(${rowPh.join(', ')})`);
        for (const c of cols.rows) values.push((r as Record<string, unknown>)[c.column_name]);
      }
      const sql = `INSERT INTO "${table}" (${colList}) VALUES ${placeholders.join(', ')} ON CONFLICT DO NOTHING`;
      try {
        await destAppPool.query(sql, values);
        totalRows += batch.rows.length;
      } catch (err) {
        warnings.push(`Seed insert into ${table} failed at offset ${offset}: ${(err as Error).message}`);
        logger.warn({ table, offset, err }, '[clone] seed insert failed; continuing with next table');
        break;
      }
      offset += SEED_BATCH_SIZE;
      if (batch.rows.length < SEED_BATCH_SIZE) break;
    }
    tablesCopied.push(table);
  }
  return { tables: tablesCopied, rows: totalRows, warnings };
}

// ---------------------------------------------------------------------------
// replayRls helpers
// ---------------------------------------------------------------------------

const CMD_MAP: Record<string, string> = {
  r: 'SELECT',
  a: 'INSERT',
  w: 'UPDATE',
  d: 'DELETE',
  '*': 'ALL',
};

/**
 * Replay RLS policies from the source app's database onto the dest app's database.
 *
 * Soft-fails per-policy: if a policy fails to apply (e.g. due to a missing
 * column or function reference), the error is recorded as a warning and the
 * clone continues. The caller is responsible for persisting the warnings.
 *
 * @param sourceAppPool - Connected pool for the source app's per-app DB.
 * @param destAppPool   - Connected pool for the dest app's per-app DB.
 * @param logger        - Logger compatible with pino's info/warn interface.
 * @returns `{ replayed, warnings }` — count of successfully replayed policies
 *          and an array of warning strings for failed ones.
 */
export async function replayRls(
  sourceAppPool: pg.Pool,
  destAppPool: pg.Pool,
  logger: ReplayLogger,
): Promise<{ replayed: number; warnings: string[] }> {
  const policies = await introspectRls(sourceAppPool);
  const warnings: string[] = [];
  let replayed = 0;

  for (const p of policies) {
    const cmd = CMD_MAP[p.command] ?? 'ALL';
    const roles =
      p.roles.length === 0 || p.roles.includes('public')
        ? 'PUBLIC'
        : p.roles.map(r => `"${r}"`).join(', ');
    const usingClause = p.using ? `USING (${p.using})` : '';
    const checkClause = p.with_check ? `WITH CHECK (${p.with_check})` : '';
    const sql = [
      `CREATE POLICY "${p.name}" ON "${p.table}"`,
      `AS ${p.permissive ? 'PERMISSIVE' : 'RESTRICTIVE'}`,
      `FOR ${cmd}`,
      `TO ${roles}`,
      usingClause,
      checkClause,
    ]
      .filter(Boolean)
      .join(' ')
      .trim();

    try {
      await destAppPool.query(sql);
      replayed++;
    } catch (err) {
      const msg = `RLS policy ${p.table}.${p.name} failed: ${(err as Error).message}`;
      warnings.push(msg);
      logger.warn(
        { table: p.table, policy: p.name, err },
        '[clone] RLS policy replay failed; continuing',
      );
    }
  }

  return { replayed, warnings };
}

// ---------------------------------------------------------------------------
// replayFunctions
// ---------------------------------------------------------------------------

/**
 * Copy non-deleted app_functions rows from the source app's runtime DB into
 * the dest app's runtime DB.
 *
 * Behavior-defining columns (name, code, description, trigger_type,
 * trigger_config, timeout_ms, memory_limit_mb, agent_tool,
 * agent_tool_description, agent_tool_mode, agent_tool_exposed_to) are copied
 * verbatim.  Runtime-stat columns (invocation_count, error_count, etc.) are
 * left at their defaults.  encrypted_env_vars is intentionally blanked (NULL)
 * per the secrets allowlist policy.
 *
 * Soft-fails per function: an insert error is recorded as a warning and the
 * clone continues with the next function.
 *
 * NOTE: app_functions lives in the RUNTIME DB (not the per-app DB), so this
 * function accepts runtime-DB pools, not per-app pools.
 *
 * @param sourceRuntimePool   - Runtime DB pool for the source app's region.
 * @param destRuntimePool     - Runtime DB pool for the dest app's region.
 * @param sourceAppId         - Source app ID.
 * @param destAppId           - Dest app ID.
 * @param requestedByUserId   - User ID to record as deployed_by on dest rows.
 * @param logger              - Logger compatible with pino's info/warn interface.
 * @returns `{ count, warnings }` — rows successfully inserted and warning strings.
 */
export async function replayFunctions(
  sourceRuntimePool: pg.Pool,
  destRuntimePool: pg.Pool,
  sourceAppId: string,
  destAppId: string,
  requestedByUserId: string,
  logger: ReplayLogger,
): Promise<{ count: number; warnings: string[] }> {
  const src = await sourceRuntimePool.query(
    `SELECT name, code, description,
            trigger_type, trigger_config,
            timeout_ms, memory_limit_mb,
            agent_tool, agent_tool_description, agent_tool_mode, agent_tool_exposed_to
       FROM app_functions
      WHERE app_id = $1 AND deleted_at IS NULL`,
    [sourceAppId],
  );

  const warnings: string[] = [];
  let inserted = 0;

  for (const f of src.rows) {
    try {
      await destRuntimePool.query(
        `INSERT INTO app_functions (
           id, app_id,
           name, code, description,
           trigger_type, trigger_config,
           timeout_ms, memory_limit_mb,
           agent_tool, agent_tool_description, agent_tool_mode, agent_tool_exposed_to,
           encrypted_env_vars,
           deployed_by, deployed_at
         ) VALUES (
           gen_random_uuid(), $1,
           $2, $3, $4,
           $5, $6,
           $7, $8,
           $9, $10, $11, $12,
           NULL,
           $13, now()
         )
         ON CONFLICT (app_id, name) DO NOTHING`,
        [
          destAppId,
          f.name, f.code, f.description,
          f.trigger_type, f.trigger_config,
          f.timeout_ms, f.memory_limit_mb,
          f.agent_tool, f.agent_tool_description, f.agent_tool_mode, f.agent_tool_exposed_to,
          requestedByUserId,
        ],
      );
      inserted++;
    } catch (err) {
      const msg = `Function ${f.name} replay failed: ${(err as Error).message}`;
      warnings.push(msg);
      logger.warn({ name: f.name, err }, '[clone] function replay failed; continuing');
    }
  }

  return { count: inserted, warnings };
}
