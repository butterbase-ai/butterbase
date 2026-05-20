#!/usr/bin/env tsx
/**
 * Stage 3a — read-only audit.
 *
 * 1. Lists migrations applied on prod control DB (PROD_CONTROL_URL).
 * 2. Confirms the 3 new DBs + standby are empty (no public tables).
 * 3. Diffs applied vs on-disk control-plane migrations.
 */
import pg from 'pg';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const REPO = path.resolve(new URL('../..', import.meta.url).pathname);

async function query<T = any>(uri: string, sql: string, params: any[] = []): Promise<T[]> {
  const pool = new pg.Pool({ connectionString: uri, max: 1 });
  try {
    const r = await pool.query(sql, params);
    return r.rows as T[];
  } finally {
    await pool.end();
  }
}

async function tableCount(uri: string, schema = 'public'): Promise<number> {
  const r = await query<{ n: string }>(
    uri,
    `SELECT count(*)::text AS n FROM information_schema.tables WHERE table_schema=$1`,
    [schema],
  );
  return Number(r[0].n);
}

async function appliedMigrations(uri: string): Promise<string[] | null> {
  try {
    const r = await query<{ filename: string }>(uri, `SELECT filename FROM _migrations ORDER BY filename`);
    return r.map((x) => x.filename);
  } catch (e: any) {
    if (/relation .* does not exist/i.test(e.message)) return null;
    throw e;
  }
}

async function listOnDisk(dir: string): Promise<string[]> {
  const files = await fs.readdir(path.join(REPO, dir));
  return files.filter((f) => f.endsWith('.sql')).sort();
}

async function main() {
  const prod = process.env.PROD_CONTROL_URL;
  const ruse1 = process.env.NEON_RUNTIME_PROJECT_ID_US_EAST_1;
  const rusw2 = process.env.NEON_RUNTIME_PROJECT_ID_US_WEST_2;
  const dusw2 = process.env.NEON_DATA_PROJECT_ID_US_WEST_2;
  const standby = process.env.PLATFORM_STANDBY_URL;

  const required = { PROD_CONTROL_URL: prod, NEON_RUNTIME_PROJECT_ID_US_EAST_1: ruse1,
    NEON_RUNTIME_PROJECT_ID_US_WEST_2: rusw2, NEON_DATA_PROJECT_ID_US_WEST_2: dusw2,
    PLATFORM_STANDBY_URL: standby };
  for (const [k, v] of Object.entries(required)) if (!v) { console.error(`Missing env: ${k}`); process.exit(2); }

  console.log('=== Stage 3a audit ===\n');

  // 1. Empty-state of new DBs
  console.log('-- New DB emptiness --');
  for (const [label, uri] of [
    ['runtime-use1', ruse1!],
    ['runtime-usw2', rusw2!],
    ['data-usw2', dusw2!],
    ['platform-standby', standby!],
  ] as const) {
    const n = await tableCount(uri);
    const applied = await appliedMigrations(uri);
    console.log(`  ${label}: ${n} public tables, _migrations=${applied === null ? 'absent' : `${applied.length} rows`}`);
  }

  // 2. Prod control migrations
  console.log('\n-- Prod control DB --');
  const prodApplied = await appliedMigrations(prod!);
  if (!prodApplied) { console.log('  _migrations table missing — unexpected'); process.exit(3); }
  console.log(`  applied: ${prodApplied.length} migrations`);

  // 3. Compare against on-disk control-plane migrations
  const onDisk = await listOnDisk('db/control-plane');
  const appliedSet = new Set(prodApplied);
  const pending = onDisk.filter((f) => !appliedSet.has(f));
  const orphan = prodApplied.filter((f) => !onDisk.includes(f));
  console.log(`  on-disk: ${onDisk.length} migrations`);
  console.log(`  pending (on-disk but not applied to prod): ${pending.length}`);
  for (const f of pending) console.log(`    + ${f}`);
  if (orphan.length) {
    console.log(`  orphan (applied to prod but not on-disk): ${orphan.length}`);
    for (const f of orphan) console.log(`    ? ${f}`);
  }

  // 4. wal_level check (read-only)
  console.log('\n-- prod wal_level --');
  const wl = await query<{ setting: string }>(prod!, `SHOW wal_level`);
  console.log(`  wal_level = ${wl[0].setting}`);

  console.log('\n=== Audit complete ===');
}

main().catch((e) => { console.error(e); process.exit(1); });
