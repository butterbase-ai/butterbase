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

export type MigrationPhase = 'pre-deploy' | 'post-deploy';
const VALID_PHASES: ReadonlySet<MigrationPhase> = new Set(['pre-deploy', 'post-deploy']);

export class MigrationPhaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationPhaseError';
  }
}

const PHASE_REGEX = /^\s*--\s*@phase\s*:\s*([a-z-]+)\s*$/;

/**
 * Parses the optional `-- @phase: <pre-deploy|post-deploy>` header from a
 * migration's leading comment block. Unlike `-- @scope:`, this header is NOT
 * required to be the first non-blank line — that line is reserved for
 * `@scope`. Instead this scans forward through the contiguous run of
 * comment/blank lines at the top of the file (the "header comment block")
 * looking for an `@phase` line, and stops as soon as it hits the first line
 * that is neither blank nor a `--` comment (i.e. real SQL).
 *
 * A file with no `@phase` header defaults to 'pre-deploy' — that is the
 * common case, and only migrations gated behind the post-deploy boundary
 * need to opt in.
 */
export function parsePhaseHeader(sql: string): MigrationPhase {
  const lines = sql.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') {
      continue;
    }
    if (!trimmed.startsWith('--')) {
      // End of the header comment block.
      break;
    }
    const match = PHASE_REGEX.exec(line);
    if (match) {
      const phase = match[1] as MigrationPhase;
      if (!VALID_PHASES.has(phase)) {
        throw new MigrationPhaseError(
          `Invalid phase "${phase}". Allowed: pre-deploy, post-deploy`
        );
      }
      return phase;
    }
  }
  return 'pre-deploy';
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

/** The env var that must be set (to '1') to allow post-deploy migrations to run. */
export const ALLOW_POST_DEPLOY_ENV_VAR = 'ALLOW_POST_DEPLOY_MIGRATIONS';

export interface MigrationPlanEntry {
  file: string;
  sql: string;
  scope: MigrationScope;
  phase: MigrationPhase;
}

export interface MigrationPlan {
  toApply: MigrationPlanEntry[];
  skipped: MigrationPlanEntry[];
}

/**
 * Pure planning step, no DB/filesystem access: given the (filename, sql)
 * pairs for every migration file, decides which ones to apply and which to
 * skip because they are marked `-- @phase: post-deploy` and the opt-in env
 * var was not set. Kept separate from `migrate()` so this decision — the
 * whole point of the phase boundary — is unit-testable without a database.
 */
export function planMigrations(
  files: Array<{ file: string; sql: string }>,
  allowPostDeploy: boolean
): MigrationPlan {
  const toApply: MigrationPlanEntry[] = [];
  const skipped: MigrationPlanEntry[] = [];

  for (const { file, sql } of files) {
    let scope: MigrationScope;
    try {
      scope = parseScopeHeader(sql);
    } catch (err) {
      throw new Error(`In ${file}: ${(err as Error).message}`);
    }
    let phase: MigrationPhase;
    try {
      phase = parsePhaseHeader(sql);
    } catch (err) {
      throw new Error(`In ${file}: ${(err as Error).message}`);
    }

    const entry: MigrationPlanEntry = { file, sql, scope, phase };
    if (phase === 'post-deploy' && !allowPostDeploy) {
      skipped.push(entry);
    } else {
      toApply.push(entry);
    }
  }

  return { toApply, skipped };
}

/**
 * Loudly reports any post-deploy migrations that were skipped, and how to
 * apply them, so an operator is never left wondering why a migration didn't
 * run. No-op when nothing was skipped.
 */
export function logSkippedPostDeploy(skipped: MigrationPlanEntry[]): void {
  if (skipped.length === 0) {
    return;
  }
  const bar = '='.repeat(78);
  console.warn(bar);
  console.warn(
    `SKIPPED ${skipped.length} post-deploy migration(s) — ${ALLOW_POST_DEPLOY_ENV_VAR} is not set:`
  );
  for (const entry of skipped) {
    console.warn(`  - ${entry.file}`);
  }
  console.warn('');
  console.warn(
    'These are gated behind the post-deploy phase boundary and will NOT run until the'
  );
  console.warn(
    'new (COALESCE-reading) code is confirmed fully live and serving traffic — not merely deployed.'
  );
  console.warn('Once that is confirmed, apply them with:');
  console.warn(`  ${ALLOW_POST_DEPLOY_ENV_VAR}=1 npm run migrate:control`);
  console.warn(bar);
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

    const fileContents = files.map((file) => ({
      file,
      sql: fs.readFileSync(path.join(__dirname, file), 'utf-8'),
    }));

    const allowPostDeploy = process.env[ALLOW_POST_DEPLOY_ENV_VAR] === '1';
    const { toApply, skipped } = planMigrations(fileContents, allowPostDeploy);

    logSkippedPostDeploy(skipped);

    for (const entry of toApply) {
      await applyByScope(entry.scope, entry.file, entry.sql, client);
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
