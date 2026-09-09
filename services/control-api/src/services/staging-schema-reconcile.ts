import type pg from 'pg';
import type { SchemaDSL } from './schema-validator.js';
import { diffSchema, type DDLStatement } from './schema-differ.js';
import { applyMigration } from './schema-applier.js';
import { introspectSchema, type IntrospectedSchema } from './schema-introspector.js';

export interface ReconcileLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
}

export interface SchemaReconcileResult {
  /** DDL actually executed against staging, in the order it ran. */
  applied: DDLStatement[];
  /**
   * One line per object this reconcile DROPPED or REWROTE on staging, in plain
   * language ('dropped staging-only column "notes"."scratch"', 'rewrote column
   * "notes"."priority" from text to integer').
   *
   * THE STANDING RULE, NINTH APPLICATION: do the conservative thing, then name
   * it. Reset is now entitled to destroy staging schema, which makes naming
   * what it destroyed non-negotiable — a user who loses a scratch table to a
   * reset must learn it from the job record, not by noticing later. The caller
   * appends these to the clone job.
   */
  destroyed: string[];
}

/**
 * Statements `diffSchema` marks `destructive: true, authorized: false`, which
 * `applyMigration` refuses outright unless something authorizes them.
 *
 * Only ONE kind reaches this: a column TYPE rewrite. Table and column drops are
 * authorized structurally instead, through the schema layer's own allow-lists
 * (`_drop` / `_dropColumns`) — see buildDesiredSchema. A type rewrite has no
 * such allow-list, so it is the single case that needs an explicit override,
 * and it is matched narrowly rather than by clearing the flag on everything
 * `diffSchema` happened to emit.
 */
const TYPE_REWRITE = /^ALTER TABLE "[^"]+" ALTER COLUMN "[^"]+" TYPE (.+)$/i;

/**
 * Adds the `USING` clause a type rewrite needs, and authorizes it.
 *
 * WHY `USING` IS NOT OPTIONAL, and why "the table is empty" is not enough.
 * Postgres refuses `ALTER COLUMN ... TYPE` whenever no ASSIGNMENT CAST exists
 * between the two types — it is a check on the TYPES, not on the rows, so it
 * fires on a table with zero rows just as hard as on a full one:
 *
 *     ERROR: column "priority" cannot be cast automatically to type integer
 *     HINT:  You might need to specify "USING priority::integer".
 *
 * That was found on the live stack, AFTER the truncate-first ordering was in
 * place and after unit tests were green — the unit tests mock applyMigration,
 * so no amount of them could have caught it. Emptiness fixes the DATA problem
 * (no value can fail to convert); it does nothing about the missing cast.
 *
 * `USING NULL::<type>` is the one expression that is valid for EVERY pair of
 * types, and it is lossless HERE, and only here, because the caller truncates
 * before reconciling: there are no rows for it to null out. That precondition
 * is the whole justification for this clause — see executeStagingReset, which
 * owns the ordering, and do not reuse this function anywhere the destination
 * table may still hold rows.
 */
function withUsingClause(s: DDLStatement): DDLStatement {
  const m = TYPE_REWRITE.exec(s.sql);
  if (!m) return s;
  const targetType = m[1].trim();
  return { ...s, sql: `${s.sql} USING NULL::${targetType}`, authorized: true };
}

/**
 * Production's schema, annotated with the removals a reset is authorized to
 * make against staging.
 *
 * `_drop` (staging-only tables) and `_dropColumns` (staging-only columns) are
 * `diffSchema`'s OWN authorization mechanism: without them it emits nothing at
 * all for a staging-only column, and emits an unauthorized `DROP TABLE`
 * described as "use _drop to remove it" for a staging-only table. Filling them
 * in is therefore not a workaround — it is telling the differ, in the vocabulary
 * it already has, that these removals are intended. Hand-writing the SQL here
 * instead would be a second, drifting implementation of statements the differ
 * already knows how to build.
 */
export function buildDesiredSchema(
  prodSchema: IntrospectedSchema, stagingSchema: IntrospectedSchema,
): Record<string, unknown> {
  const stagingOnlyTables = Object.keys(stagingSchema.tables)
    .filter((t) => !prodSchema.tables[t]).sort();

  const tables: Record<string, unknown> = {};
  for (const [name, prodTable] of Object.entries(prodSchema.tables)) {
    const stagingTable = stagingSchema.tables[name];
    const dropColumns = stagingTable
      ? Object.keys(stagingTable.columns).filter((c) => !(c in prodTable.columns)).sort()
      : [];
    tables[name] = dropColumns.length > 0
      ? { ...prodTable, _dropColumns: dropColumns }
      : prodTable;
  }

  return { ...prodSchema, tables, _drop: stagingOnlyTables };
}

/** Plain-language disclosure line for one destructive statement. */
function describeDestruction(s: DDLStatement): string | null {
  const dropTable = /^DROP TABLE IF EXISTS "([^"]+)"/i.exec(s.sql);
  if (dropTable) {
    return `dropped staging-only table "${dropTable[1]}" (it does not exist in production)`;
  }
  const dropColumn = /^ALTER TABLE "([^"]+)" DROP COLUMN "([^"]+)"/i.exec(s.sql);
  if (dropColumn) {
    return `dropped staging-only column "${dropColumn[1]}"."${dropColumn[2]}" `
      + '(it does not exist in production)';
  }
  if (TYPE_REWRITE.test(s.sql)) {
    // diffSchema's description already reads "Change type of "t"."c" from X to
    // Y" — the from/to pair is the whole point of the disclosure, and it is not
    // recoverable from the SQL, which carries only the target type.
    return `rewrote ${s.description.replace(/^Change type of /, 'column ')}`;
  }
  const dropIndex = /^DROP INDEX IF EXISTS "([^"]+)"/i.exec(s.sql);
  if (dropIndex) {
    return `dropped staging-only index "${dropIndex[1]}" (it does not exist in production)`;
  }
  const dropConstraint = /^ALTER TABLE "([^"]+)" DROP CONSTRAINT "([^"]+)"/i.exec(s.sql);
  if (dropConstraint) {
    return `dropped constraint "${dropConstraint[2]}" on "${dropConstraint[1]}" to match production`;
  }
  if (/DROP NOT NULL|DROP DEFAULT|SET NOT NULL|SET DEFAULT/i.test(s.sql)) {
    return `${s.description.charAt(0).toLowerCase()}${s.description.slice(1)} to match production`;
  }
  return null;
}

/**
 * Makes staging's SCHEMA look like production's again before a reset copies
 * production's ROWS into it.
 *
 * WHY THIS EXISTS. Reset's contract is "make staging look like production
 * again", and the app-copy engine reads production's column list and INSERTs
 * it into staging verbatim. Once staging's schema has diverged — which the
 * feature's own supported flow produces, since promote deliberately never
 * carries a staging column DROP over to production (promote-preview's
 * `ignoredRemovals`) — every row of that copy fails with `column "x" of
 * relation "y" does not exist` and the reset job goes to `failed`. Nothing in
 * the pipeline reconciled schema, so that state never self-healed: the only
 * way out was hand-written DDL on the staging database.
 *
 * RESET IS THE DESTRUCTIVE OPERATION, BY CONSTRUCTION, AND ONLY AGAINST
 * STAGING. This function drops staging-only tables and columns, rewrites
 * diverged column types, and relaxes or tightens constraints and defaults to
 * match production. That is a deliberate owner ruling and it is narrow:
 *
 *   - Reset already truncates every row in staging, and is advertised as
 *     discarding staging's data. The DATA in a staging-only table is gone
 *     either way; leaving the empty object behind while the whole operation
 *     FAILS serves nobody, and the failure it caused is exactly what made this
 *     defect severe — a staging environment that could never be reset again.
 *   - PROMOTE is the operation that must never destroy, and its hard refusal
 *     (promote-preview's `blocked` / `filterAdditive`) is untouched. Do not
 *     generalise this file's behaviour back onto that path: they are opposite
 *     directions with opposite contracts.
 *
 * DIRECTION IS PRODUCTION -> STAGING, the inverse of promote. `diffSchema`
 * reads (current, desired); here `current` is STAGING and `desired` is
 * PRODUCTION, i.e. "what would staging have to do to look like production".
 * buildPromotePreview passes exactly the opposite pair. Swapping these two
 * arguments would compute the DDL that makes PRODUCTION look like staging —
 * and this function now EXECUTES destructive DDL, so that mistake would drop a
 * customer's production columns. Both are read from named parameters, never
 * positionally re-derived, and `assertStagingTarget` below is the runtime
 * backstop.
 *
 * NEVER TOUCHES PRODUCTION. `prodPool` is read-only here: `introspectSchema` is
 * the only function it is ever passed to. Every write goes to `stagingPool`,
 * and only after `assertStagingTarget` has re-run the caller's three guards
 * (id pair, pool identity, and `current_database()` against the staging db
 * name) immediately before the DDL executes.
 *
 * RUNS AFTER THE TRUNCATE, NOT BEFORE. On an empty table `ALTER COLUMN ...
 * TYPE` needs no `USING` clause and cannot fail on the data, and `SET NOT
 * NULL` cannot fail on an existing NULL. Ordering it after the truncate is
 * what makes "reset always succeeds" true rather than merely intended — see
 * executeStagingReset, which owns that ordering.
 */
export async function reconcileStagingSchema(args: {
  prodPool: pg.Pool;
  stagingPool: pg.Pool;
  stagingAppId: string;
  /**
   * Re-runs the caller's destination guards. Called immediately before any DDL
   * executes and expected to THROW if staging is not provably the target.
   *
   * Injected rather than implemented here because the guards need the reset
   * job's id pair and the staging app's `db_name`, which are the task
   * wrapper's knowledge, not this module's — and because there must be exactly
   * one implementation of them, shared with the truncate.
   */
  assertStagingTarget: () => Promise<void>;
  logger: ReconcileLogger;
}): Promise<SchemaReconcileResult> {
  const { prodPool, stagingPool, stagingAppId, assertStagingTarget, logger } = args;

  const prodSchema = await introspectSchema(prodPool);
  const stagingSchema = await introspectSchema(stagingPool);

  // (current, desired) = (staging, production). See the doc comment: the
  // opposite of buildPromotePreview's argument order, on purpose.
  const desired = buildDesiredSchema(prodSchema, stagingSchema);
  const statements = diffSchema(
    stagingSchema as unknown as SchemaDSL,
    desired as unknown as SchemaDSL,
  );

  // The one authorization diffSchema cannot express through _drop/_dropColumns,
  // plus the `USING` clause Postgres requires for it. Narrow on purpose: a
  // blanket `authorized: true` would also authorize whatever future destructive
  // statement the differ learns to emit, silently.
  const authorized = statements.map(withUsingClause);

  const destroyed = authorized
    .map(describeDestruction)
    .filter((d): d is string => d !== null);

  if (authorized.length > 0) {
    // GUARDS IMMEDIATELY BEFORE THE DDL, not merely earlier in the reset. This
    // path now executes DROP TABLE / DROP COLUMN / ALTER COLUMN ... TYPE, so it
    // carries the same hazard the TRUNCATE does and gets the same protection at
    // the same distance: aimed at the wrong pool it would destroy a customer's
    // production schema.
    await assertStagingTarget();

    await applyMigration(stagingPool, authorized, 'staging-reset-schema');
    logger.info(
      { stagingAppId, statements: authorized.map((s) => s.sql), destroyed },
      '[staging-reset] replayed production schema onto staging',
    );
  }

  if (destroyed.length > 0) {
    logger.warn(
      { stagingAppId, destroyed },
      '[staging-reset] reset destroyed staging schema objects to match production',
    );
  }

  return {
    applied: authorized,
    destroyed,
  };
}
