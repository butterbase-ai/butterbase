import type pg from 'pg';
import type { SchemaDSL } from './schema-validator.js';
import { diffSchema, type DDLStatement } from './schema-differ.js';
import { filterAdditive } from './schema-additive-filter.js';
import { introspectSchema } from './schema-introspector.js';

export interface PromotePreview {
  additive: DDLStatement[];
  blocked: DDLStatement[];
  canPromote: boolean;
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

  return { additive: kept, blocked: rejected, canPromote: rejected.length === 0 };
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
