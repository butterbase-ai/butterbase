import type pg from 'pg';
import type { SchemaDSL } from './schema-validator.js';
import { diffSchema, type DDLStatement } from './schema-differ.js';
import { filterAdditive } from './schema-additive-filter.js';
import { introspectSchema, type IntrospectedSchema } from './schema-introspector.js';

export interface PromotePreview {
  additive: DDLStatement[];
  blocked: DDLStatement[];
  canPromote: boolean;
  /**
   * Human-readable descriptions of tables/columns that exist in production but
   * not in staging, which promote will NOT remove. `diffSchema` never emits a
   * statement for these: table removal is gated behind `desired._drop` and
   * column removal behind `desired._dropColumns` — both are SchemaDSL-only
   * authorization allow-lists that an introspected schema has no equivalent
   * for, so they are always absent here and the corresponding branches never
   * fire. That is safe (nothing gets wrongly dropped) but silent, which breaks
   * the "name every consequence" promise the rest of this preview makes — so
   * these are surfaced, not blocked. They never affect canPromote.
   */
  ignoredRemovals: string[];
}

/**
 * Table/column removals present in production but absent from staging that
 * `diffSchema` will not act on (see `ignoredRemovals` above). Computed by
 * comparing the two introspected schemas directly rather than routing through
 * `diffSchema`, since `diffSchema` has no branch that would report these.
 */
function computeIgnoredRemovals(
  prodSchema: IntrospectedSchema,
  stagingSchema: IntrospectedSchema,
): string[] {
  const removals: string[] = [];

  for (const [tableName, prodTable] of Object.entries(prodSchema.tables)) {
    const stagingTable = stagingSchema.tables[tableName];
    if (!stagingTable) {
      removals.push(`table "${tableName}"`);
      continue;
    }
    for (const columnName of Object.keys(prodTable.columns)) {
      if (!(columnName in stagingTable.columns)) {
        removals.push(`column "${tableName}"."${columnName}"`);
      }
    }
  }

  return removals;
}

/**
 * Dry-run of the schema half of a promote.
 *
 * The diff direction is production (current) → staging (desired): we are asking
 * "what would production need to do to look like staging". Reversing these
 * arguments silently produces the statements that would undo the user's work.
 *
 * diffSchema's declared signature is (current: IntrospectedSchema, desired:
 * SchemaDSL), but both arguments here are IntrospectedSchema results from
 * introspectSchema — there is no SchemaDSL (source-file DSL) on either side of
 * a promote, only two live databases. This mirrors the existing two-app diff
 * in clone-replay.ts (`replaySchema`), which casts an introspected dest schema
 * through `unknown` to SchemaDSL for the same reason: diffSchema only reads
 * the `tables`/`_drop` shape that both types share structurally.
 *
 * Destructive statements are a hard refusal, not a warning. filterAdditive is
 * the same gate the template-update path uses, and it keys on statement kind
 * rather than the advisory `destructive` flag.
 */
export async function buildPromotePreview(
  stagingPool: pg.Pool, prodPool: pg.Pool,
): Promise<PromotePreview> {
  const prodSchema = await introspectSchema(prodPool);
  const stagingSchema = await introspectSchema(stagingPool);

  const statements = diffSchema(
    prodSchema as unknown as SchemaDSL,
    stagingSchema as unknown as SchemaDSL,
  );
  const { kept, rejected } = filterAdditive(statements);
  const ignoredRemovals = computeIgnoredRemovals(prodSchema, stagingSchema);

  return {
    additive: kept,
    blocked: rejected,
    canPromote: rejected.length === 0,
    ignoredRemovals,
  };
}

export function formatBlockedStatements(blocked: DDLStatement[]): string {
  const lines = blocked.map((s) => `  • ${s.sql}`).join('\n');
  return (
    'Promote refused: the following changes would destroy production data, and '
    + 'promote never applies destructive DDL.\n\n'
    + lines
    + '\n\nApply these directly to production yourself if you intend them, then '
    + 'promote again.'
  );
}

/**
 * User-facing note for `PromotePreview.ignoredRemovals`. A separate formatter
 * from `formatBlockedStatements` on purpose: these are not blockers (promote
 * still proceeds) and not destructive to production — they are removals
 * staging made that promote will not carry over, so production simply keeps
 * them. Returns '' when there is nothing to report.
 */
export function formatIgnoredRemovals(ignoredRemovals: string[]): string {
  if (ignoredRemovals.length === 0) return '';
  const lines = ignoredRemovals.map((r) => `  • ${r}`).join('\n');
  return (
    'Not applied — production will keep these:\n\n'
    + lines
    + '\n\nThese exist in production but were removed in staging. Promote never '
    + 'removes tables or columns, so they will not be applied; production keeps '
    + 'them as-is.'
  );
}
