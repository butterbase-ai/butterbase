#!/usr/bin/env tsx
/**
 * One-off: apply the 9 "agent_runtime" orphan migrations (extracted from
 * feat/agentic-ai-gateway-plan-1, written to /tmp/orphan-migrations/) to the
 * standby. Records them in _migrations so the selective applier sees them as
 * already applied. Wrapping each in a transaction; if any fails, rollback.
 *
 * Goal: make standby's schema match prod EXACTLY (prod has these 9
 * applied) so logical replication FOR ALL TABLES doesn't fail.
 */
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';

const ORPHAN_DIR = '/tmp/orphan-migrations';
const ORPHANS = [
  '051_agent_runtime.sql',
  '052_agent_tools.sql',
  '053_agent_runtime_durability.sql',
  '054_agent_webhook_payload.sql',
  '055_function_triggers.sql',
  '056_function_invocations_retry.sql',
  '057_dispatcher_cursors.sql',
  '058_agent_end_user_invocation.sql',
  '059_apps_anon_key_default.sql',
];

async function main() {
  const url = process.env.PLATFORM_STANDBY_URL;
  if (!url) { console.error('PLATFORM_STANDBY_URL required'); process.exit(2); }

  const pool = new pg.Pool({ connectionString: url, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [73248621]);

    let applied = 0, skipped = 0;
    for (const file of ORPHANS) {
      const already = await client.query('SELECT 1 FROM _migrations WHERE filename = $1', [file]);
      if (already.rowCount! > 0) { console.log(`  skip:    ${file} (already applied)`); skipped++; continue; }

      const sql = fs.readFileSync(path.join(ORPHAN_DIR, file), 'utf8');
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
    console.log(`\n[apply-orphans] done. applied=${applied} skipped=${skipped}`);
  } finally {
    try { await client.query('SELECT pg_advisory_unlock($1)', [73248621]); } catch {}
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
