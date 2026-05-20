#!/usr/bin/env tsx
/**
 * Selective control-plane migration applier.
 *
 * Mirrors db/control-plane/migrate.ts (advisory lock, _migrations tracking,
 * transactional per-file) but supports allow-list / deny-list of files so the
 * cutover deploy can apply migrations in lockstep with the maintenance window.
 *
 * Usage:
 *   apply-control-migrations.mts --target <url> [--only a,b,c] [--skip a,b,c] [--dry-run]
 *
 * `--only` and `--skip` take comma-separated filename PREFIXES (e.g. "060,061").
 * They match any filename starting with that prefix.
 *
 * Examples:
 *   # Stage 3d: apply 001-059 to standby
 *   apply-control-migrations.mts --target "$PLATFORM_STANDBY_URL" --skip 060,061,062,063,064,065
 *
 *   # Stage 5 cutover: apply 062-065 to prod + standby
 *   apply-control-migrations.mts --target "$PROD_CONTROL_URL" --only 062,063,064,065
 *
 *   # Stage 7: apply 061 to both
 *   apply-control-migrations.mts --target "$PROD_CONTROL_URL" --only 061
 */
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';

const MIGRATIONS_DIR = path.resolve(
  new URL('../..', import.meta.url).pathname,
  'db/control-plane',
);

interface Args {
  target: string;
  only: string[] | null;
  skip: string[];
  dryRun: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const args: Args = { target: '', only: null, skip: [], dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--target') args.target = argv[++i];
    else if (a === '--only') args.only = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--skip') args.skip = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--dry-run') args.dryRun = true;
    else { console.error(`Unknown arg: ${a}`); process.exit(2); }
  }
  if (!args.target) { console.error('--target required'); process.exit(2); }
  return args;
}

function matchesPrefix(filename: string, prefixes: string[]): boolean {
  return prefixes.some((p) => filename.startsWith(p));
}

function parseScope(sql: string): string {
  const m = /^\s*--\s*@scope\s*:\s*([a-z]+)\s*$/m.exec(sql.split('\n').slice(0, 5).join('\n'));
  if (!m) throw new Error('Missing @scope header');
  return m[1];
}

async function main() {
  const args = parseArgs();

  const allFiles = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  const selected = allFiles.filter((f) => {
    if (args.only && !matchesPrefix(f, args.only)) return false;
    if (args.skip.length && matchesPrefix(f, args.skip)) return false;
    return true;
  });

  console.log(`[apply-control-migrations] target=${maskUri(args.target)}`);
  console.log(`[apply-control-migrations] candidates: ${selected.length}/${allFiles.length}`);
  console.log(`[apply-control-migrations] only=${args.only?.join(',') ?? '(any)'}  skip=${args.skip.join(',') || '(none)'}`);
  if (args.dryRun) {
    selected.forEach((f) => console.log(`  WOULD apply: ${f}`));
    console.log('[apply-control-migrations] dry-run — no DB changes');
    return;
  }

  const pool = new pg.Pool({ connectionString: args.target, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [73248621]);
    await client.query(`CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      filename TEXT NOT NULL UNIQUE,
      scope TEXT NOT NULL DEFAULT 'platform',
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await client.query(`ALTER TABLE _migrations ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'platform'`);

    let applied = 0, skipped = 0;
    for (const file of selected) {
      const already = await client.query('SELECT 1 FROM _migrations WHERE filename = $1', [file]);
      if (already.rowCount! > 0) { console.log(`  skip:    ${file} (already applied)`); skipped++; continue; }

      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      const scope = parseScope(sql);
      if (scope !== 'platform') throw new Error(`${file}: scope=${scope}, expected platform`);

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO _migrations (filename, scope) VALUES ($1, $2)', [file, 'platform']);
        await client.query('COMMIT');
        console.log(`  applied: ${file}`);
        applied++;
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`${file} failed: ${(err as Error).message}`);
      }
    }
    console.log(`\n[apply-control-migrations] done. applied=${applied} skipped=${skipped} total_selected=${selected.length}`);
  } finally {
    try { await client.query('SELECT pg_advisory_unlock($1)', [73248621]); } catch {}
    client.release();
    await pool.end();
  }
}

function maskUri(uri: string): string {
  return uri.replace(/:[^@/]+@/, ':***@');
}

main().catch((e) => { console.error(e); process.exit(1); });
