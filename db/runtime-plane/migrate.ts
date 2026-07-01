import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class MigrationScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationScopeError';
  }
}

const SCOPE_REGEX = /^\s*--\s*@scope\s*:\s*([a-z]+)\s*$/;

function regionToEnvSuffix(region: string): string {
  return region.toUpperCase().replace(/-/g, '_');
}

export function resolveRuntimeUrls(
  regions: string[],
  env: Record<string, string | undefined>
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const region of regions) {
    const envName = `NEON_RUNTIME_PROJECT_ID_${regionToEnvSuffix(region)}`;
    const value = env[envName];
    if (!value) {
      throw new Error(
        `Missing env var ${envName} (required because "${region}" is in BUTTERBASE_REGIONS)`
      );
    }
    map[region] = value;
  }
  return map;
}

export function parseScopeHeader(sql: string): string {
  const lines = sql.split('\n');
  let firstNonBlank: string | null = null;
  for (const line of lines) {
    if (line.trim() !== '') {
      firstNonBlank = line;
      break;
    }
  }
  if (firstNonBlank === null) throw new MigrationScopeError('Migration file is empty');
  const match = SCOPE_REGEX.exec(firstNonBlank);
  if (!match) {
    throw new MigrationScopeError('Missing required `-- @scope: runtime` header');
  }
  return match[1];
}

async function applyToRegion(
  region: string,
  url: string,
  files: { name: string; sql: string }[]
): Promise<void> {
  const pool = new pg.Pool({ connectionString: url });
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [73248622]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS _runtime_migrations (
        id SERIAL PRIMARY KEY,
        filename TEXT NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    for (const { name, sql } of files) {
      const { rows } = await client.query(
        'SELECT 1 FROM _runtime_migrations WHERE filename = $1',
        [name]
      );
      if (rows.length > 0) {
        console.log(`  [${region}] skip: ${name}`);
        continue;
      }
      await client.query('BEGIN');
      try {
        // SET does not accept parameterised values; use a GUC-safe literal form instead.
        await client.query(`SELECT set_config('butterbase.region', $1, true)`, [region]);
        await client.query(sql);
        await client.query('INSERT INTO _runtime_migrations (filename) VALUES ($1)', [name]);
        await client.query('COMMIT');
        console.log(`  [${region}] applied: ${name}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${name} failed in region ${region}: ${err}`);
      }
    }
  } finally {
    try { await client.query('SELECT pg_advisory_unlock($1)', [73248622]); } catch {}
    client.release();
    await pool.end();
  }
}

async function migrate(): Promise<void> {
  const regionsRaw = process.env.BUTTERBASE_REGIONS;
  if (!regionsRaw) throw new Error('BUTTERBASE_REGIONS env var is required');
  const regions = regionsRaw.split(',').map((s) => s.trim()).filter(Boolean);
  const urls = resolveRuntimeUrls(regions, process.env);

  const files = fs
    .readdirSync(__dirname)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => {
      const sql = fs.readFileSync(path.join(__dirname, name), 'utf-8');
      const scope = parseScopeHeader(sql);
      if (scope !== 'runtime') {
        throw new Error(`File ${name} in db/runtime-plane/ has scope=${scope}; expected runtime`);
      }
      return { name, sql };
    });

  const results = await Promise.allSettled(
    Object.entries(urls).map(([region, url]) => applyToRegion(region, url, files))
  );

  const failures = results
    .map((r, i) => ({ r, region: Object.keys(urls)[i] }))
    .filter((x) => x.r.status === 'rejected');

  if (failures.length > 0) {
    for (const { region, r } of failures) {
      console.error(`Region ${region} failed: ${(r as PromiseRejectedResult).reason}`);
    }
    throw new Error(`${failures.length}/${results.length} regions failed migration. Check logs and rerun.`);
  }

  console.log('Runtime migrations complete across all regions.');
}

const isDirectInvocation = import.meta.url === `file://${process.argv[1]}`;
if (isDirectInvocation) {
  migrate().catch((err) => {
    console.error('Migration error:', err);
    process.exit(1);
  });
}
