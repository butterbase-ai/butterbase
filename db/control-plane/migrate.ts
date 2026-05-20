import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type MigrationScope = 'platform' | 'runtime' | 'data';
const VALID_SCOPES: ReadonlySet<MigrationScope> = new Set(['platform', 'runtime', 'data']);

export class MigrationScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationScopeError';
  }
}

const SCOPE_REGEX = /^\s*--\s*@scope\s*:\s*([a-z]+)\s*$/;

/**
 * Parses the `-- @scope: <tier>` header from the first non-blank line of a migration.
 * Throws MigrationScopeError if the header is missing, malformed, or has an invalid value.
 */
export function parseScopeHeader(sql: string): MigrationScope {
  const lines = sql.split('\n');
  let firstNonBlank: string | null = null;
  for (const line of lines) {
    if (line.trim() !== '') {
      firstNonBlank = line;
      break;
    }
  }
  if (firstNonBlank === null) {
    throw new MigrationScopeError('Migration file is empty');
  }
  const match = SCOPE_REGEX.exec(firstNonBlank);
  if (!match) {
    throw new MigrationScopeError(
      'Migration is missing required `-- @scope: <platform|runtime|data>` header on its first non-blank line'
    );
  }
  const scope = match[1] as MigrationScope;
  if (!VALID_SCOPES.has(scope)) {
    throw new MigrationScopeError(
      `Invalid scope "${scope}". Allowed: platform, runtime, data`
    );
  }
  return scope;
}

async function ensureMigrationsTable(client: pg.PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      filename TEXT NOT NULL UNIQUE,
      scope TEXT NOT NULL DEFAULT 'platform',
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await client.query(`ALTER TABLE _migrations ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'platform'`);
}

async function isAlreadyApplied(client: pg.PoolClient, file: string): Promise<boolean> {
  const { rows } = await client.query('SELECT 1 FROM _migrations WHERE filename = $1', [file]);
  return rows.length > 0;
}

async function applyPlatformMigration(client: pg.PoolClient, file: string, sql: string): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query('INSERT INTO _migrations (filename, scope) VALUES ($1, $2)', [file, 'platform']);
    await client.query('COMMIT');
    console.log(`  applied: ${file} -> platform`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw new Error(`Migration ${file} failed on platform: ${err}`);
  }
}

/**
 * Dispatches a parsed migration to the right runner.
 * Exported so tests can verify runtime/data scopes throw without touching a DB.
 * For runtime/data, throws synchronously without using `client`.
 */
export async function applyByScope(
  scope: MigrationScope,
  file: string,
  sql: string,
  client: pg.PoolClient
): Promise<void> {
  if (scope === 'platform') {
    if (await isAlreadyApplied(client, file)) {
      console.log(`  skip: ${file} (already applied to platform)`);
      return;
    }
    await applyPlatformMigration(client, file, sql);
  } else if (scope === 'runtime') {
    throw new Error(
      `Migration ${file} declares scope=runtime but it is under db/control-plane/. ` +
      `Move it to db/runtime-plane/ and re-run db/runtime-plane/migrate.ts.`
    );
  } else if (scope === 'data') {
    throw new Error(
      `Migration ${file} declares scope=data but per-region data DB routing is not implemented until Phase 4.`
    );
  }
}

async function migrate(): Promise<void> {
  const url =
    process.env.NEON_PLATFORM_PRIMARY_URL ??
    process.env.CONTROL_DB_URL ??
    'postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control';
  const pool = new pg.Pool({ connectionString: url });
  const client = await pool.connect();
  try {
    // Advisory lock so concurrent migration runs serialize. Number is arbitrary but
    // must be stable across runs. Using a fixed integer derived from "butterbase-migrations".
    await client.query('SELECT pg_advisory_lock($1)', [73248621]);
    await ensureMigrationsTable(client);

    const files = fs
      .readdirSync(__dirname)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      const sql = fs.readFileSync(path.join(__dirname, file), 'utf-8');
      let scope: MigrationScope;
      try {
        scope = parseScopeHeader(sql);
      } catch (err) {
        throw new Error(`In ${file}: ${(err as Error).message}`);
      }
      await applyByScope(scope, file, sql, client);
    }

    console.log('Migrations complete.');
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [73248621]);
    } catch {
      // best effort
    }
    client.release();
    await pool.end();
  }
}

// Only auto-run when invoked directly, not when imported by tests.
const isDirectInvocation = import.meta.url === `file://${process.argv[1]}`;
if (isDirectInvocation) {
  migrate().catch((err) => {
    console.error('Migration error:', err);
    process.exit(1);
  });
}
