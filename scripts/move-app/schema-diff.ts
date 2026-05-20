#!/usr/bin/env tsx
/**
 * Schema-diff gate for the Stage 5 cutover.
 *
 * Compares the columns of the runtime-tier tables present in a given Postgres
 * (typically a read-only Neon branch of prod control DB) against what
 * db/runtime-plane/001_initial_runtime_schema.sql defines as the canonical
 * runtime schema. Reports any column-level mismatches that would cause the
 * pg_dump | psql data copy in Stage 5 to fail or silently truncate.
 *
 * Usage:
 *   npx tsx scripts/move-app/schema-diff.ts <prod-readonly-uri>
 *
 * Region identifiers are NEVER hardcoded — the table list comes from
 * MOVE_APP_RUNTIME_TABLES + the `apps` table itself.
 */
import pg from 'pg';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MOVE_APP_RUNTIME_TABLES, MOVE_APP_EXCLUDED } from '../../services/control-api/src/services/move-app/runtime-tables.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const SCHEMA_FILE = path.join(REPO_ROOT, 'db/runtime-plane/001_initial_runtime_schema.sql');

interface Column {
  name: string;
  dataType: string;        // pg's information_schema.columns.data_type (e.g. "integer", "text")
  isNullable: boolean;
  defaultExpr: string | null;
}

interface TableSchema {
  columns: Map<string, Column>;
}

function normalizeType(t: string): string {
  // Trim trailing parenthesized precision (e.g. "character varying(255)" → "character varying")
  // We only care about logical type equality; precision differences are usually safe.
  let n = t.toLowerCase().replace(/\s*\(.*\)\s*$/, '').trim();
  // information_schema.columns.data_type returns "ARRAY" for any array type.
  // SQL-parsed schemas have e.g. "text[]" / "uuid[]". Collapse both to "array".
  if (n.endsWith('[]')) n = 'array';
  // Some common aliases
  if (n === 'character varying') n = 'varchar';
  if (n === 'timestamp with time zone') n = 'timestamptz';
  if (n === 'timestamp without time zone') n = 'timestamp';
  return n;
}

async function readProdSchema(uri: string, tables: string[]): Promise<Map<string, TableSchema>> {
  const pool = new pg.Pool({ connectionString: uri, max: 2 });
  try {
    const { rows } = await pool.query<{
      table_name: string;
      column_name: string;
      data_type: string;
      is_nullable: 'YES' | 'NO';
      column_default: string | null;
    }>(
      `SELECT table_name, column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = ANY($1)
       ORDER BY table_name, ordinal_position`,
      [tables],
    );
    const out = new Map<string, TableSchema>();
    for (const r of rows) {
      let t = out.get(r.table_name);
      if (!t) { t = { columns: new Map() }; out.set(r.table_name, t); }
      t.columns.set(r.column_name, {
        name: r.column_name,
        dataType: normalizeType(r.data_type),
        isNullable: r.is_nullable === 'YES',
        defaultExpr: r.column_default,
      });
    }
    return out;
  } finally {
    await pool.end();
  }
}

/**
 * Parse the canonical 001_initial_runtime_schema.sql to extract column info
 * for the tables we care about. We do this without a real Postgres instance
 * to avoid requiring a temporary DB.
 *
 * The SQL is pg_dump-style: `CREATE TABLE public.<name> (\n    col TYPE [NULL|NOT NULL] [DEFAULT ...],\n    ...);`
 */
async function readCanonicalSchema(tables: string[]): Promise<Map<string, TableSchema>> {
  const sql = await fs.readFile(SCHEMA_FILE, 'utf8');
  const out = new Map<string, TableSchema>();

  for (const table of tables) {
    const re = new RegExp(
      `CREATE TABLE public\\.${table}\\s*\\(([\\s\\S]*?)\\n\\);`,
      'm',
    );
    const m = sql.match(re);
    if (!m) continue;
    const body = m[1];
    const ts: TableSchema = { columns: new Map() };

    // Each column line is roughly: "    col_name TYPE [NULL|NOT NULL] [DEFAULT expr],"
    // pg_dump style separates columns/constraints; we skip constraint lines.
    const lines = body.split('\n');
    for (const rawLine of lines) {
      const line = rawLine.trim().replace(/,$/, '');
      if (!line) continue;
      // Skip table-level constraint lines
      if (/^(CONSTRAINT|PRIMARY KEY|FOREIGN KEY|UNIQUE|CHECK)\b/i.test(line)) continue;
      // Match: identifier (possibly quoted) followed by a type word/phrase, then optional NULL/NOT NULL/DEFAULT
      const colMatch = line.match(/^"?(\w+)"?\s+(.+)$/);
      if (!colMatch) continue;
      const [, name, rest] = colMatch;
      // Strip trailing NOT NULL / NULL / DEFAULT clauses to isolate type
      let typeStr = rest;
      let isNullable = true;
      let defaultExpr: string | null = null;

      const notNullMatch = /\bNOT\s+NULL\b/i.exec(typeStr);
      if (notNullMatch) {
        isNullable = false;
        typeStr = typeStr.slice(0, notNullMatch.index) + typeStr.slice(notNullMatch.index + notNullMatch[0].length);
      }
      const defaultMatch = /\bDEFAULT\s+(.+)$/i.exec(typeStr);
      if (defaultMatch) {
        defaultExpr = defaultMatch[1].trim();
        typeStr = typeStr.slice(0, defaultMatch.index);
      }
      typeStr = typeStr.replace(/\bNULL\b/i, '').trim();

      ts.columns.set(name, {
        name,
        dataType: normalizeType(typeStr),
        isNullable,
        defaultExpr,
      });
    }
    if (ts.columns.size > 0) out.set(table, ts);
  }
  return out;
}

interface Diff {
  table: string;
  kind: 'missing-in-canonical' | 'missing-in-prod' | 'type-mismatch' | 'nullability-mismatch';
  column: string;
  prod?: Column;
  canonical?: Column;
}

function diffTables(prod: Map<string, TableSchema>, canonical: Map<string, TableSchema>): Diff[] {
  const diffs: Diff[] = [];
  const allTables = new Set([...prod.keys(), ...canonical.keys()]);
  for (const table of allTables) {
    const p = prod.get(table);
    const c = canonical.get(table);
    if (!p && c) {
      diffs.push({ table, kind: 'missing-in-prod', column: '(whole table)', canonical: undefined });
      continue;
    }
    if (p && !c) {
      diffs.push({ table, kind: 'missing-in-canonical', column: '(whole table)', prod: undefined });
      continue;
    }
    if (!p || !c) continue;
    const allCols = new Set([...p.columns.keys(), ...c.columns.keys()]);
    for (const col of allCols) {
      const pc = p.columns.get(col);
      const cc = c.columns.get(col);
      if (pc && !cc) {
        diffs.push({ table, kind: 'missing-in-canonical', column: col, prod: pc });
        continue;
      }
      if (!pc && cc) {
        diffs.push({ table, kind: 'missing-in-prod', column: col, canonical: cc });
        continue;
      }
      if (!pc || !cc) continue;
      if (pc.dataType !== cc.dataType) {
        diffs.push({ table, kind: 'type-mismatch', column: col, prod: pc, canonical: cc });
      }
      if (pc.isNullable !== cc.isNullable) {
        diffs.push({ table, kind: 'nullability-mismatch', column: col, prod: pc, canonical: cc });
      }
    }
  }
  return diffs;
}

async function main() {
  const uri = process.argv[2];
  if (!uri) {
    console.error('Usage: npx tsx scripts/move-app/schema-diff.ts <prod-readonly-uri>');
    process.exit(2);
  }

  // Tables to diff: MOVE_APP_RUNTIME_TABLES + 'apps' (apps is the system row, separate from the move list).
  const tables = [...MOVE_APP_RUNTIME_TABLES, 'apps'];
  console.log(`Diffing ${tables.length} runtime-tier tables\n`);

  const [prod, canonical] = await Promise.all([
    readProdSchema(uri, tables),
    readCanonicalSchema(tables),
  ]);

  const diffs = diffTables(prod, canonical);

  // archived_after_move is added by Phase 5 (migration 004) + Phase 6 (006).
  // It's expected to be missing in prod (added by Stage 3 runtime migrations
  // before Stage 5 cutover) OR missing in canonical (when self-diffing a
  // post-Phase-6 local DB). Ignore in both directions.
  const ignoredCols = new Set(['archived_after_move']);
  const blocking = diffs.filter((d) => !ignoredCols.has(d.column));

  console.log(`Found ${diffs.length} raw diffs; ${blocking.length} blocking after filtering expected.\n`);

  if (blocking.length === 0) {
    console.log('✓ Schema diff clean. Safe to proceed with Stage 5 cutover.');
    process.exit(0);
  }

  console.log('Blocking diffs:\n');
  const byTable = new Map<string, Diff[]>();
  for (const d of blocking) {
    let arr = byTable.get(d.table); if (!arr) { arr = []; byTable.set(d.table, arr); }
    arr.push(d);
  }
  for (const [table, ds] of byTable) {
    console.log(`# ${table}`);
    for (const d of ds) {
      switch (d.kind) {
        case 'missing-in-prod':
          console.log(`  - column "${d.column}" exists in canonical but not in prod`);
          if (d.canonical) console.log(`      canonical: ${d.canonical.dataType}${d.canonical.isNullable ? '' : ' NOT NULL'}${d.canonical.defaultExpr ? ` DEFAULT ${d.canonical.defaultExpr}` : ''}`);
          break;
        case 'missing-in-canonical':
          console.log(`  - column "${d.column}" exists in prod but not in canonical schema`);
          if (d.prod) console.log(`      prod: ${d.prod.dataType}${d.prod.isNullable ? '' : ' NOT NULL'}`);
          break;
        case 'type-mismatch':
          console.log(`  - column "${d.column}" type mismatch: prod=${d.prod?.dataType}  canonical=${d.canonical?.dataType}`);
          break;
        case 'nullability-mismatch':
          console.log(`  - column "${d.column}" nullability mismatch: prod=${d.prod?.isNullable ? 'NULL' : 'NOT NULL'}  canonical=${d.canonical?.isNullable ? 'NULL' : 'NOT NULL'}`);
          break;
      }
    }
    console.log('');
  }
  console.log('Fix 001_initial_runtime_schema.sql (or write a per-table mapping for Stage 5) before cutover.');
  process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(2); });
