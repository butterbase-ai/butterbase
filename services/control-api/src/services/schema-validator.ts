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
  default: z.string().optional(),
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
  opclass: z.string().optional(),
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
