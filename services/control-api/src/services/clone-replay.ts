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
