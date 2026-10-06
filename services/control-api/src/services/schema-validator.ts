import { z } from 'zod';

// Valid SQL identifier pattern
const identifierPattern = /^[a-z_][a-z0-9_]*$/;

// Allowed Postgres types (case-insensitive match)
const ALLOWED_TYPES = new Set([
  'text', 'varchar', 'char', 'uuid', 'boolean', 'bool',
  'integer', 'int', 'int4', 'bigint', 'int8', 'smallint', 'int2',
  'serial', 'bigserial', 'smallserial',
  'real', 'float4', 'float8', 'double precision', 'numeric', 'decimal',
  'timestamptz', 'timestamp', 'date', 'time', 'timetz', 'interval',
  'jsonb', 'json', 'bytea',
]);

function isValidType(type: string): boolean {
  const lower = type.toLowerCase();
  if (ALLOWED_TYPES.has(lower)) return true;
  // varchar(N), char(N), numeric(P,S)
  if (/^(varchar|char|numeric|decimal)\(\d+(,\s*\d+)?\)$/.test(lower)) return true;
  // vector(N)
  if (/^vector(\(\d+\))?$/.test(lower)) return true;
  // arrays like text[], integer[]
  if (/^[a-z]+\[\]$/.test(lower) && ALLOWED_TYPES.has(lower.replace('[]', ''))) return true;
  return false;
}


// ---------------------------------------------------------------------------
// Column DEFAULT / index opclass safety
// ---------------------------------------------------------------------------
//
// `default` and `opclass` are interpolated verbatim into DDL (schema-differ
// emits `... SET DEFAULT ${col.default}`), and schema-applier runs each
// statement through client.query(sql) with no bind params — Postgres's SIMPLE
// query protocol, which executes `;`-chained statements. An unvalidated default
// was therefore arbitrary SQL execution inside the migration transaction.
//
// Not merely self-inflicted: the template-update path replays a template's
// schema onto every fork, so a payload authored once ran on other people's
// databases. filterAdditive is no defence — it rejects destructive DDL *kinds*,
// and `UPDATE members SET role='admin'` is not one.
//
// DDL defaults cannot be parameterized, so the control is an allowlist. This is
// a tokenizer rather than one big regex for two reasons: the regex version
// rejected `(now() + '24:00:00'::interval)`, a real default on a live template,
// and a grammar this permissive is not something anyone can audit as a regex.

/** Functions permitted in a default. `now()` is harmless, `pg_read_file()` is
 *  not, and nothing distinguishes them automatically. Extend consciously. */
const ALLOWED_DEFAULT_FUNCTIONS = new Set([
  'now', 'current_timestamp', 'current_date', 'current_time',
  'localtime', 'localtimestamp', 'statement_timestamp', 'transaction_timestamp',
  'clock_timestamp', 'gen_random_uuid', 'uuid_generate_v4', 'nextval',
  'date_trunc', 'to_timestamp', 'age', 'coalesce', 'array', 'jsonb_build_object',
  'json_build_object', 'array_to_json',
]);

/** Barewords that may stand alone (no parentheses). */
const ALLOWED_DEFAULT_KEYWORDS = new Set([
  'true', 'false', 'null',
  'current_date', 'current_timestamp', 'current_time',
  'localtime', 'localtimestamp',
]);

/** Operators allowed between operands. */
const ALLOWED_OPERATORS = new Set(['+', '-', '*', '/', '||']);

/**
 * True if `d` is a column DEFAULT expression we are willing to interpolate.
 *
 * Accepts: string/numeric literals, the standalone datetime keywords,
 * allowlisted function calls, `::type` casts (including `numeric(10,2)` and
 * `text[]`), parenthesised sub-expressions, and the operators above.
 *
 * Rejects rather than escapes — an arbitrary SQL *expression* cannot be escaped
 * safely. A rejection must surface as a validation error naming the field, never
 * be silently dropped: a dropped default changes the table's semantics.
 */
export function isSafeColumnDefault(d: string): boolean {
  const src = d.trim();
  if (src.length === 0 || src.length > 1000) return false;

  let i = 0;
  let depth = 0;
  let afterCast = false;   // the next identifier is a TYPE name, not a function
  let prevSignificant = ''; // last token emitted, for operator/operand sanity

  while (i < src.length) {
    const c = src[i];

    // Whitespace
    if (/\s/.test(c)) { i++; continue; }

    // String literal — content is inert, but the quoting must close.
    if (c === "'") {
      i++;
      for (;;) {
        if (i >= src.length) return false;              // unterminated
        if (src[i] === "'") {
          if (src[i + 1] === "'") { i += 2; continue; } // '' escape
          i++; break;
        }
        i++;
      }
      prevSignificant = 'operand';
      afterCast = false;
      continue;
    }

    // Comment introducers and statement separators are never legitimate here.
    if (c === ';' || c === '$' || c === '"' || c === '\\' || c === '@' || c === '#') return false;
    if (c === '-' && src[i + 1] === '-') return false;
    if (c === '/' && src[i + 1] === '*') return false;

    // Cast
    if (c === ':' && src[i + 1] === ':') { i += 2; afterCast = true; continue; }

    // Parens
    if (c === '(') { depth++; i++; prevSignificant = 'open'; continue; }
    if (c === ')') { depth--; if (depth < 0) return false; i++; prevSignificant = 'operand'; continue; }

    // Array-type brackets, only meaningful right after a cast type
    if (c === '[' || c === ']') { i++; continue; }

    // Argument separator
    if (c === ',') { i++; prevSignificant = 'op'; continue; }

    // Operators
    if (c === '|' && src[i + 1] === '|') { i += 2; prevSignificant = 'op'; continue; }
    if (ALLOWED_OPERATORS.has(c)) {
      // A leading +/- is a sign on a number, which is fine either way.
      i++; prevSignificant = 'op'; continue;
    }

    // Numeric literal
    if (/[0-9]/.test(c)) {
      while (i < src.length && /[0-9.]/.test(src[i])) i++;
      if (i < src.length && /[eE]/.test(src[i]) && /[0-9+-]/.test(src[i + 1] ?? '')) {
        i += 2;
        while (i < src.length && /[0-9]/.test(src[i])) i++;
      }
      prevSignificant = 'operand';
      afterCast = false;
      continue;
    }

    // Identifier: function name, type name, or standalone keyword
    if (/[A-Za-z_]/.test(c)) {
      const startI = i;
      while (i < src.length && /[A-Za-z0-9_]/.test(src[i])) i++;
      const word = src.slice(startI, i).toLowerCase();

      // A type name after `::` — any identifier is fine; it is not executable.
      if (afterCast) { afterCast = false; prevSignificant = 'operand'; continue; }

      // Look ahead past whitespace for a '(' to decide function vs keyword.
      let j = i;
      while (j < src.length && /\s/.test(src[j])) j++;
      const isCall = src[j] === '(';

      if (isCall) {
        if (!ALLOWED_DEFAULT_FUNCTIONS.has(word)) return false;
      } else if (!ALLOWED_DEFAULT_KEYWORDS.has(word)) {
        // A bare identifier that is not a keyword would be a column or
        // function reference — refuse it.
        return false;
      }
      prevSignificant = 'operand';
      continue;
    }

    // Anything else is unrecognised, so refuse.
    return false;
  }

  if (depth !== 0) return false;
  if (prevSignificant === 'op' || prevSignificant === 'open') return false;
  return true;
}

/** Index operator classes are bare identifiers (vector_cosine_ops, gin_trgm_ops). */
export function isSafeOpclass(o: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(o);
}

const referentialActionEnum = z.enum([
  'CASCADE', 'SET NULL', 'SET DEFAULT', 'RESTRICT', 'NO ACTION',
]);

const ForeignKeyRefSchema = z.object({
  table: z.string().regex(identifierPattern, 'Invalid table name'),
  column: z.string().regex(identifierPattern, 'Invalid column name'),
  onDelete: referentialActionEnum.optional(),
  onUpdate: referentialActionEnum.optional(),
}).strict();

const ColumnDefSchema = z.object({
  type: z.string().refine(isValidType, {
    message: 'Invalid or unsupported column type',
  }),
  primaryKey: z.boolean().optional(),
  nullable: z.boolean().optional(),
  default: z.string().refine(isSafeColumnDefault, {
    message:
      'Unsupported DEFAULT expression. Allowed: literals, TRUE/FALSE/NULL, the ' +
      'CURRENT_* datetime keywords, and simple calls such as now() or ' +
      'gen_random_uuid(), each with an optional ::type cast.',
  }).optional(),
  unique: z.boolean().optional(),
  references: z.union([
    z.string().regex(/^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/, 'Must be "table.column"'),
    ForeignKeyRefSchema,
  ]).optional(),
}).strict();

const IndexDefSchema = z.object({
  columns: z.array(z.string().regex(identifierPattern)),
  unique: z.boolean().optional(),
  method: z.enum(['btree', 'hash', 'gist', 'gin', 'hnsw', 'ivfflat']).optional(),
  opclass: z.string().refine(isSafeOpclass, {
    message: 'Operator class must be a bare identifier, e.g. vector_cosine_ops.',
  }).optional(),
});

const TableDefSchema = z.object({
  columns: z.record(z.string().regex(identifierPattern), ColumnDefSchema),
  indexes: z.record(z.string().regex(identifierPattern), IndexDefSchema).optional(),
  _dropColumns: z.array(z.string().regex(identifierPattern)).optional(),
  _seed: z.boolean().optional(),
});

export const SchemaDSLSchema = z.object({
  tables: z.record(z.string().regex(identifierPattern), TableDefSchema).refine(
    (tables) => Object.keys(tables).length <= 50,
    { message: 'Maximum 50 tables per schema' }
  ),
  _drop: z.array(z.string().regex(identifierPattern)).optional(),
});

export type SchemaDSL = z.infer<typeof SchemaDSLSchema>;
export type TableDef = z.infer<typeof TableDefSchema>;
export type ColumnDef = z.infer<typeof ColumnDefSchema>;
export type IndexDef = z.infer<typeof IndexDefSchema>;

export type ForeignKeyRef = z.infer<typeof ForeignKeyRefSchema>;

export interface NormalizedFKRef {
  table: string;
  column: string;
  onDelete: string;
  onUpdate: string;
}

// Normalize a column DEFAULT expression for equality comparison only.
// Postgres canonicalizes `DEFAULT 'pending'` to `'pending'::text` in pg_attrdef,
// so a DSL-authored `default: "'pending'"` won't string-equal the introspected
// form. Strip a single outer string-literal cast on both sides before comparing.
// NEVER use the return value to emit DDL — use the raw value so Postgres parses
// it correctly.
export function normalizeDefault(d: string | undefined): string | undefined {
  if (d === undefined) return undefined;
  const trimmed = d.trim();
  const m = trimmed.match(/^'((?:[^']|'')*)'::[A-Za-z_][\w\s"()[\]]*$/);
  return m ? `'${m[1]}'` : trimmed;
}

export function normalizeFKRef(ref: string | ForeignKeyRef): NormalizedFKRef {
  if (typeof ref === 'string') {
    const [table, column] = ref.split('.');
    return { table, column, onDelete: 'NO ACTION', onUpdate: 'NO ACTION' };
  }
  return {
    table: ref.table,
    column: ref.column,
    onDelete: ref.onDelete ?? 'NO ACTION',
    onUpdate: ref.onUpdate ?? 'NO ACTION',
  };
}
