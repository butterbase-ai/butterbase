import type pg from 'pg';
import type { SchemaDSL } from './schema-validator.js';
import { diffSchema, type DDLStatement } from './schema-differ.js';
import { filterAdditive } from './schema-additive-filter.js';
import { applyMigration } from './schema-applier.js';
import { describeMissing, introspectSchema } from './schema-introspector.js';

export interface ReconcileLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
}

export interface SchemaReconcileResult {
  /** DDL actually executed against staging, in the order it ran. */
  applied: DDLStatement[];
  /**
   * Production's table set, as introspected here.
   *
   * Returned rather than re-introspected by the caller because the reset needs
   * exactly this list to answer "which staging tables did I empty that the
   * production copy will never refill", and re-running introspectSchema for it
   * would both cost a second round trip and open a window in which the two
   * answers disagree.
   */
  productionTables: string[];
  /**
   * Human-readable descriptions of everything the reconcile could NOT fix,
   * one line each. Empty means staging's schema is now a superset of
   * production's in every way that matters to the data copy.
   */
  unreconciled: string[];
}

/**
 * Makes staging's SCHEMA look like production's again, additively, before a
 * reset copies production's ROWS into it.
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
 * DIRECTION IS PRODUCTION -> STAGING, the inverse of promote. `diffSchema`
 * reads (current, desired); here `current` is STAGING and `desired` is
 * PRODUCTION, i.e. "what would staging have to do to look like production".
 * buildPromotePreview passes exactly the opposite pair. Swapping these two
 * arguments would compute the DDL that makes PRODUCTION look like staging —
 * and, unlike promote, nothing downstream re-checks the direction, because the
 * statements are applied to the pool passed in as `stagingPool`. Both are read
 * from named parameters, never positionally re-derived.
 *
 * ADDITIVE ONLY, AND IT SAYS WHAT IT COULD NOT FIX. `filterAdditive` is the
 * same gate the template-update and promote paths use; it admits CREATE TABLE
 * and ADD COLUMN and rejects anything that drops or narrows. A column dropped
 * in staging therefore comes back; a column whose TYPE was changed in staging
 * does not, because reconciling it would mean an `ALTER COLUMN ... TYPE` that
 * destroys whatever staging holds in that column, and a column that exists
 * ONLY in staging does not, because reconciling it would mean dropping it.
 * Both of those are destructive choices that this function is not entitled to
 * make on the user's behalf, so they are REPORTED (`unreconciled`) rather than
 * performed or silently ignored. The caller turns that list into a job
 * warning: the reset may still fail downstream, but it fails having already
 * told the user precisely which piece of divergence it could not repair.
 *
 * NEVER TOUCHES PRODUCTION. `prodPool` is read-only here — `introspectSchema`
 * is the only thing it is ever passed to.
 */
export async function reconcileStagingSchema(args: {
  prodPool: pg.Pool;
  stagingPool: pg.Pool;
  stagingAppId: string;
  logger: ReconcileLogger;
}): Promise<SchemaReconcileResult> {
  const { prodPool, stagingPool, stagingAppId, logger } = args;

  const prodSchema = await introspectSchema(prodPool);
  const stagingSchema = await introspectSchema(stagingPool);

  // (current, desired) = (staging, production). See the doc comment: the
  // opposite of buildPromotePreview's argument order, on purpose.
  const statements = diffSchema(
    stagingSchema as unknown as SchemaDSL,
    prodSchema as unknown as SchemaDSL,
  );
  const { kept, rejected } = filterAdditive(statements);

  if (kept.length > 0) {
    await applyMigration(stagingPool, kept, 'staging-reset-schema');
    logger.info(
      { stagingAppId, statements: kept.map((s) => s.sql) },
      '[staging-reset] replayed production schema onto staging (additive only)',
    );
  }

  // STAGING-ONLY TABLES AND COLUMNS, computed directly rather than read off
  // `rejected`, because `diffSchema` reports only half of them and reports
  // that half in DSL terms a reset caller cannot act on. A staging-only TABLE
  // does produce a statement — an unauthorized `DROP TABLE IF EXISTS ...
  // CASCADE` described as "use _drop to remove it", advice addressed to
  // someone editing a schema DSL file, which nobody is doing here. A
  // staging-only COLUMN produces nothing at all (column removal is gated
  // behind `desired._dropColumns`, which an introspected schema never
  // carries). Reporting both from one comparison is the only way they read
  // consistently — the same reason promote-preview computes its
  // `ignoredRemovals` outside diffSchema.
  const stagingOnly = describeMissing(stagingSchema, prodSchema);
  const stagingOnlyTables = new Set(
    Object.keys(stagingSchema.tables).filter((t) => !prodSchema.tables[t]),
  );

  const unreconciled: string[] = [];
  for (const r of rejected) {
    // Skip the DROP TABLE the paragraph above describes: it says the same
    // thing as the staging-only line below, in worse words, and a duplicated
    // warning trains users to skim them.
    const dropsStagingOnlyTable = [...stagingOnlyTables].some(
      (t) => r.sql === `DROP TABLE IF EXISTS "${t}" CASCADE`,
    );
    if (dropsStagingOnlyTable) continue;
    unreconciled.push(
      `${r.description} — production and staging disagree here in a way that only destructive `
      + `DDL could reconcile (${r.sql}), and reset never applies destructive DDL to staging's `
      + 'schema.',
    );
  }

  if (stagingOnly.length > 0) {
    unreconciled.push(
      `${stagingOnly.length} object(s) exist in staging but not in production and were left in `
      + `place: ${stagingOnly.join(', ')}. Reset never drops schema, so they remain. Production `
      + 'has no data for them; a staging-only column that is NOT NULL without a default will '
      + 'make the data copy fail.',
    );
  }

  if (unreconciled.length > 0) {
    logger.warn(
      { stagingAppId, unreconciled },
      '[staging-reset] staging schema could not be fully reconciled with production',
    );
  }

  return { applied: kept, productionTables: Object.keys(prodSchema.tables), unreconciled };
}
