import { createHash } from 'node:crypto';
import pg from 'pg';
import type { DDLStatement } from './schema-differ.js';

export interface MigrationResult {
  applied: number;
  statements: Array<{ sql: string; description: string }>;
  migration_id: number;
}

function generateSqlDown(statements: DDLStatement[]): string {
  const reverseStatements: string[] = [];

  for (const stmt of [...statements].reverse()) {
    const sql = stmt.sql;

    if (/^CREATE TABLE "(\w+)"/.test(sql)) {
      const table = sql.match(/^CREATE TABLE "(\w+)"/)?.[1];
      reverseStatements.push(`DROP TABLE IF EXISTS "${table}" CASCADE`);
    } else if (/^DROP TABLE/.test(sql)) {
      reverseStatements.push(`-- manual restore needed: ${stmt.description}`);
    } else if (/^ALTER TABLE "(\w+)" ADD COLUMN (.+)/.test(sql)) {
      const match = sql.match(/^ALTER TABLE "(\w+)" ADD COLUMN "(\w+)"/);
      if (match) reverseStatements.push(`ALTER TABLE "${match[1]}" DROP COLUMN "${match[2]}"`);
    } else if (/^ALTER TABLE "(\w+)" DROP COLUMN "(\w+)"/.test(sql)) {
      reverseStatements.push(`-- manual restore needed: ${stmt.description}`);
    } else if (/^CREATE (?:UNIQUE )?INDEX "(\w+)"/.test(sql)) {
      const idx = sql.match(/^CREATE (?:UNIQUE )?INDEX "(\w+)"/)?.[1];
      reverseStatements.push(`DROP INDEX IF EXISTS "${idx}"`);
    } else if (/^DROP INDEX/.test(sql)) {
      reverseStatements.push(`-- manual restore needed: ${stmt.description}`);
    } else if (/^ALTER TABLE .+ ALTER COLUMN .+ TYPE/.test(sql)) {
      reverseStatements.push(`-- manual restore needed: ${stmt.description}`);
    } else if (/^ALTER TABLE "(\w+)" ALTER COLUMN "(\w+)" SET NOT NULL/.test(sql)) {
      const match = sql.match(/^ALTER TABLE "(\w+)" ALTER COLUMN "(\w+)"/);
      if (match) reverseStatements.push(`ALTER TABLE "${match[1]}" ALTER COLUMN "${match[2]}" DROP NOT NULL`);
    } else if (/^ALTER TABLE "(\w+)" ALTER COLUMN "(\w+)" DROP NOT NULL/.test(sql)) {
      const match = sql.match(/^ALTER TABLE "(\w+)" ALTER COLUMN "(\w+)"/);
      if (match) reverseStatements.push(`ALTER TABLE "${match[1]}" ALTER COLUMN "${match[2]}" SET NOT NULL`);
    } else if (/^ALTER TABLE .+ ALTER COLUMN .+ SET DEFAULT/.test(sql)) {
      const match = sql.match(/^ALTER TABLE "(\w+)" ALTER COLUMN "(\w+)"/);
      if (match) reverseStatements.push(`ALTER TABLE "${match[1]}" ALTER COLUMN "${match[2]}" DROP DEFAULT`);
    } else if (/^ALTER TABLE .+ ALTER COLUMN .+ DROP DEFAULT/.test(sql)) {
      reverseStatements.push(`-- manual restore needed: ${stmt.description}`);
    } else if (/^ALTER TABLE .+ ADD CONSTRAINT/.test(sql)) {
      const match = sql.match(/ADD CONSTRAINT "(\w+)"/);
      const table = sql.match(/^ALTER TABLE "(\w+)"/)?.[1];
      if (match && table) reverseStatements.push(`ALTER TABLE "${table}" DROP CONSTRAINT "${match[1]}"`);
    } else if (/^ALTER TABLE "(\w+)" DROP CONSTRAINT "(\w+)"/.test(sql)) {
      reverseStatements.push(`-- manual restore needed: ${stmt.description}`);
    } else {
      reverseStatements.push(`-- unknown reverse: ${sql}`);
    }
  }

  return reverseStatements.join(';\n');
}

export async function applyMigration(
  pool: pg.Pool,
  statements: DDLStatement[],
  name: string
): Promise<MigrationResult> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const executedStatements: Array<{ sql: string; description: string }> = [];

    const newTables: string[] = [];

    for (const stmt of statements) {
      await client.query(stmt.sql);
      executedStatements.push({
        sql: stmt.sql,
        description: stmt.description,
      });

      // Track newly created tables for GRANT below
      const createMatch = stmt.sql.match(/^CREATE TABLE "(\w+)"/);
      if (createMatch) newTables.push(createMatch[1]);
    }

    // Explicitly grant DML permissions on new tables and their sequences
    // to the three RLS roles. This is belt-and-suspenders alongside
    // ALTER DEFAULT PRIVILEGES — it ensures grants fire even when the
    // connection role doesn't match the role that set default privileges
    // (e.g. pgbouncer pooling, Neon branching, or local dev).
    for (const table of newTables) {
      await client.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON "${table}" TO butterbase_anon, butterbase_user, butterbase_service`
      );
      // Grant on any serial/identity sequences owned by the table
      const seqResult = await client.query<{ seq: string }>(
        `SELECT pg_get_serial_sequence(quote_ident($1), a.attname) AS seq
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         WHERE c.relname = $1
           AND a.attnum > 0
           AND NOT a.attisdropped
           AND pg_get_serial_sequence(quote_ident($1), a.attname) IS NOT NULL`,
        [table]
      );
      for (const { seq } of seqResult.rows) {
        await client.query(
          `GRANT USAGE, SELECT ON SEQUENCE ${seq} TO butterbase_anon, butterbase_user, butterbase_service`
        );
      }
    }

    // Ensure seed-table marker exists (defensive: handles apps provisioned before
    // data-plane migration 012 ran, i.e. any app already in the field).
    await client.query(`
      CREATE TABLE IF NOT EXISTS _seed_tables (name TEXT PRIMARY KEY)
    `);

    // Log migration
    const sqlUp = statements.map((s) => s.sql).join(';\n');
    const sqlDown = generateSqlDown(statements);
    const checksum = createHash('sha256').update(sqlUp).digest('hex');

    const { rows } = await client.query<{ id: number }>(
      `INSERT INTO _ai_migrations (name, applied_by, sql_up, sql_down, checksum)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [name, 'mcp', sqlUp, sqlDown, checksum]
    );

    await client.query('COMMIT');

    // Reconcile realtime triggers post-commit. DROP TABLE / CREATE TABLE
    // takes the per-table trigger with it, but realtime.watched_tables
    // (the registration that drives the dashboard's "Enabled" list) is
    // unaffected — so without this step the control-plane row claims a
    // table is realtime-enabled while no trigger exists, and subscribers
    // sit silent forever. Best-effort: log on failure, never fail the
    // migration we already committed.
    await reconcileRealtimeTriggers(pool).catch(() => {
      // intentionally swallow — migration is already committed; reconciliation
      // is a self-healing nicety, not load-bearing for the migration itself.
    });

    return {
      applied: executedStatements.length,
      statements: executedStatements,
      migration_id: rows[0].id,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function reconcileRealtimeTriggers(pool: pg.Pool): Promise<void> {
  // The realtime schema may not exist on very old apps that pre-date
  // template migration 007 — bail quietly in that case.
  const schemaCheck = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'realtime' AND table_name = 'watched_tables'
     ) AS exists`
  );
  if (!schemaCheck.rows[0]?.exists) return;

  const watched = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM realtime.watched_tables`
  );

  for (const { table_name } of watched.rows) {
    // Did the table itself survive the migration?
    const tableExists = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = $1
       ) AS exists`,
      [table_name]
    );

    if (!tableExists.rows[0]?.exists) {
      // Table was dropped outright. Clean up the registration so the
      // dashboard stops claiming it's enabled.
      await pool.query(
        `DELETE FROM realtime.watched_tables WHERE table_name = $1`,
        [table_name]
      );
      continue;
    }

    // Table exists. Is the trigger still attached?
    const triggerName = `trg_realtime_${table_name.replace(/\./g, '_')}`;
    const triggerExists = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_trigger WHERE tgname = $1
       ) AS exists`,
      [triggerName]
    );

    if (!triggerExists.rows[0]?.exists) {
      // Reinstall — enable_table_trigger is idempotent (DROP IF EXISTS + CREATE).
      await pool.query(`SELECT realtime.enable_table_trigger($1)`, [table_name]);
    }
  }
}
