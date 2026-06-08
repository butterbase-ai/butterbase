import pg from 'pg';
import type { ForeignKeyRef } from './schema-validator.js';

export interface ColumnInfo {
  type: string;
  primaryKey?: boolean;
  nullable?: boolean;
  default?: string;
  unique?: boolean;
  references?: string | ForeignKeyRef;
}

export interface IndexInfo {
  columns: string[];
  unique?: boolean;
  method?: string;
  opclass?: string;
}

export interface TableInfo {
  columns: Record<string, ColumnInfo>;
  indexes?: Record<string, IndexInfo>;
  _seed?: boolean;
}

export interface IntrospectedSchema {
  tables: Record<string, TableInfo>;
  _fkConstraints?: Record<string, string>;
}

const EXCLUDED_TABLES = [
  '_ai_migrations',
  '_data_plane_migrations',
  '_rag_collections',
  '_rag_documents',
  '_rag_chunks',
  '_idempotency_keys',
  '_seed_tables',
];

export async function introspectSchema(pool: pg.Pool): Promise<IntrospectedSchema> {
  const schema: IntrospectedSchema = { tables: {} };

  // Get all user tables
  const tablesResult = await pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables
     WHERE schemaname = 'public'
     AND tablename NOT LIKE 'pg_%'
     AND tablename NOT IN (${EXCLUDED_TABLES.map((_, i) => `$${i + 1}`).join(',')})
     ORDER BY tablename`,
    EXCLUDED_TABLES
  );

  if (tablesResult.rows.length === 0) return schema;

  const tableNames = tablesResult.rows.map((r) => r.tablename);

  // Get columns for all tables
  const columnsResult = await pool.query<{
    table_name: string;
    column_name: string;
    data_type: string;
    udt_name: string;
    is_nullable: string;
    column_default: string | null;
    character_maximum_length: number | null;
    numeric_precision: number | null;
    numeric_scale: number | null;
  }>(
    `SELECT table_name, column_name, data_type, udt_name, is_nullable,
            column_default, character_maximum_length, numeric_precision, numeric_scale
     FROM information_schema.columns
     WHERE table_schema = 'public'
     AND table_name = ANY($1)
     ORDER BY table_name, ordinal_position`,
    [tableNames]
  );

  // Get primary keys
  const pkResult = await pool.query<{
    table_name: string;
    column_name: string;
  }>(
    `SELECT tc.table_name, kcu.column_name
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema = kcu.table_schema
     WHERE tc.constraint_type = 'PRIMARY KEY'
     AND tc.table_schema = 'public'
     AND tc.table_name = ANY($1)`,
    [tableNames]
  );

  const pkSet = new Set(
    pkResult.rows.map((r) => `${r.table_name}.${r.column_name}`)
  );

  // Get unique constraints (single-column only for DSL simplicity)
  const uniqueResult = await pool.query<{
    table_name: string;
    column_name: string;
  }>(
    `SELECT tc.table_name, kcu.column_name
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema = kcu.table_schema
     WHERE tc.constraint_type = 'UNIQUE'
     AND tc.table_schema = 'public'
     AND tc.table_name = ANY($1)`,
    [tableNames]
  );

  const uniqueSet = new Set(
    uniqueResult.rows.map((r) => `${r.table_name}.${r.column_name}`)
  );

  // Get foreign keys with referential actions
  const fkResult = await pool.query<{
    table_name: string;
    column_name: string;
    foreign_table_name: string;
    foreign_column_name: string;
    on_delete: string;
    on_update: string;
    constraint_name: string;
  }>(
    `SELECT
       cl.relname AS table_name,
       a.attname AS column_name,
       clf.relname AS foreign_table_name,
       af.attname AS foreign_column_name,
       c.confdeltype AS on_delete,
       c.confupdtype AS on_update,
       c.conname AS constraint_name
     FROM pg_constraint c
     JOIN pg_class cl ON cl.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = cl.relnamespace
     JOIN pg_class clf ON clf.oid = c.confrelid
     JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
     JOIN pg_attribute af ON af.attrelid = c.confrelid
       AND af.attnum = c.confkey[array_position(c.conkey, a.attnum)]
     WHERE c.contype = 'f'
       AND n.nspname = 'public'
       AND cl.relname = ANY($1)`,
    [tableNames]
  );

  const ACTION_MAP: Record<string, string> = {
    a: 'NO ACTION',
    r: 'RESTRICT',
    c: 'CASCADE',
    n: 'SET NULL',
    d: 'SET DEFAULT',
  };

  interface FKMapEntry {
    foreignTable: string;
    foreignColumn: string;
    onDelete: string;
    onUpdate: string;
    constraintName: string;
  }

  const fkMap = new Map<string, FKMapEntry>();
  for (const r of fkResult.rows) {
    fkMap.set(`${r.table_name}.${r.column_name}`, {
      foreignTable: r.foreign_table_name,
      foreignColumn: r.foreign_column_name,
      onDelete: ACTION_MAP[r.on_delete] ?? 'NO ACTION',
      onUpdate: ACTION_MAP[r.on_update] ?? 'NO ACTION',
      constraintName: r.constraint_name,
    });
  }

  // Get indexes (excluding constraint-backing indexes like UNIQUE constraints)
  const indexResult = await pool.query<{
    tablename: string;
    indexname: string;
    indexdef: string;
  }>(
    `SELECT i.tablename, i.indexname, i.indexdef
     FROM pg_indexes i
     LEFT JOIN pg_constraint c
       ON c.conname = i.indexname
       AND c.connamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
     WHERE i.schemaname = 'public'
     AND i.tablename = ANY($1)
     AND i.indexname NOT LIKE '%_pkey'
     AND c.oid IS NULL
     ORDER BY i.tablename, i.indexname`,
    [tableNames]
  );

  // Build schema
  for (const tableName of tableNames) {
    const table: TableInfo = { columns: {} };

    const cols = columnsResult.rows.filter((r) => r.table_name === tableName);
    for (const col of cols) {
      const colType = resolveColumnType(col);
      const info: ColumnInfo = { type: colType };

      const key = `${tableName}.${col.column_name}`;

      if (pkSet.has(key)) info.primaryKey = true;
      if (col.is_nullable === 'NO' && !info.primaryKey) info.nullable = false;
      if (uniqueSet.has(key)) info.unique = true;
      if (fkMap.has(key)) {
        const fk = fkMap.get(key)!;
        if (fk.onDelete === 'NO ACTION' && fk.onUpdate === 'NO ACTION') {
          info.references = `${fk.foreignTable}.${fk.foreignColumn}`;
        } else {
          const ref: ForeignKeyRef = { table: fk.foreignTable, column: fk.foreignColumn };
          if (fk.onDelete !== 'NO ACTION') ref.onDelete = fk.onDelete as ForeignKeyRef['onDelete'];
          if (fk.onUpdate !== 'NO ACTION') ref.onUpdate = fk.onUpdate as ForeignKeyRef['onUpdate'];
          info.references = ref;
        }
      }

      if (col.column_default !== null) {
        // Skip SERIAL/IDENTITY sequence defaults — recreated by the dest's own DDL.
        if (col.column_default.startsWith('nextval(')) continue;
        // Store the raw Postgres-canonical expression (e.g. 'pending'::text).
        // It must be valid as-is when re-emitted in CREATE TABLE DDL; the differ
        // normalizes for equality comparison via normalizeDefault.
        info.default = col.column_default;
      }

      table.columns[col.column_name] = info;
    }

    // Parse indexes
    const idxs = indexResult.rows.filter((r) => r.tablename === tableName);
    if (idxs.length > 0) {
      table.indexes = {};
      for (const idx of idxs) {
        const parsed = parseIndexDef(idx.indexdef);
        if (parsed) {
          table.indexes[idx.indexname] = parsed;
        }
      }
    }

    schema.tables[tableName] = table;
  }

  // Build FK constraint name map for the differ
  const fkConstraints: Record<string, string> = {};
  for (const [key, entry] of fkMap) {
    fkConstraints[key] = entry.constraintName;
  }
  if (Object.keys(fkConstraints).length > 0) {
    schema._fkConstraints = fkConstraints;
  }

  // Read _seed_tables to annotate seed marker on tables that have it set.
  // _seed_tables may not exist on older apps (pre-migration 012) — handle defensively.
  try {
    const seedResult = await pool.query<{ name: string }>(
      `SELECT name FROM _seed_tables`
    );
    const seedSet = new Set(seedResult.rows.map((r) => r.name));
    for (const tableName of Object.keys(schema.tables)) {
      if (seedSet.has(tableName)) {
        schema.tables[tableName]._seed = true;
      }
    }
  } catch {
    // _seed_tables does not exist yet on this app — skip silently.
  }

  return schema;
}

function resolveColumnType(col: {
  data_type: string;
  udt_name: string;
  character_maximum_length: number | null;
  numeric_precision: number | null;
  numeric_scale: number | null;
}): string {
  // Handle user-defined types (like vector)
  if (col.data_type === 'USER-DEFINED') {
    return col.udt_name;
  }
  // Handle varchar with length
  if (col.data_type === 'character varying' && col.character_maximum_length) {
    return `varchar(${col.character_maximum_length})`;
  }
  // Handle numeric with precision/scale
  if (col.data_type === 'numeric' && col.numeric_precision !== null && col.numeric_scale !== null) {
    return `numeric(${col.numeric_precision},${col.numeric_scale})`;
  }
  // Map information_schema types to common Postgres types
  const typeMap: Record<string, string> = {
    'character varying': 'varchar',
    'character': 'char',
    'timestamp with time zone': 'timestamptz',
    'timestamp without time zone': 'timestamp',
    'double precision': 'float8',
    'boolean': 'boolean',
    'integer': 'integer',
    'bigint': 'bigint',
    'smallint': 'smallint',
    'text': 'text',
    'uuid': 'uuid',
    'jsonb': 'jsonb',
    'json': 'json',
    'numeric': 'numeric',
    'real': 'real',
    'bytea': 'bytea',
    'date': 'date',
    'time without time zone': 'time',
    'time with time zone': 'timetz',
    'interval': 'interval',
    'ARRAY': `${col.udt_name.replace(/^_/, '')}[]`,
  };

  return typeMap[col.data_type] || col.data_type;
}

export function parseIndexDef(indexdef: string): IndexInfo | null {
  // Example: CREATE INDEX idx_name ON public.table USING btree (col1, col2)
  // Example: CREATE UNIQUE INDEX idx_name ON public.table USING hnsw (embedding vector_cosine_ops)
  const unique = indexdef.includes('UNIQUE INDEX');

  const usingMatch = indexdef.match(/USING\s+(\w+)\s+\((.+)\)/i);
  if (!usingMatch) return null;

  const method = usingMatch[1].toLowerCase();
  const colsPart = usingMatch[2];

  // Parse columns, handling opclass specifications
  const columns: string[] = [];
  let opclass: string | undefined;

  const parts = colsPart.split(',').map((s) => s.trim());
  for (const part of parts) {
    const tokens = part.split(/\s+/);
    // pg quotes reserved-word column names in indexdef (e.g. "position"); the
    // differ re-quotes whatever we store, so strip surrounding quotes here to
    // avoid emitting `""position""` (parsed by Postgres as an empty identifier).
    const raw = tokens[0];
    const name =
      raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')
        ? raw.slice(1, -1).replace(/""/g, '"')
        : raw;
    columns.push(name);
    if (tokens.length > 1 && tokens[1] !== 'ASC' && tokens[1] !== 'DESC') {
      opclass = tokens[1];
    }
  }

  const info: IndexInfo = { columns };
  if (unique) info.unique = true;
  if (method !== 'btree') info.method = method;
  if (opclass) info.opclass = opclass;

  return info;
}
