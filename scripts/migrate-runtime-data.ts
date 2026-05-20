#!/usr/bin/env tsx
/**
 * One-time data copy from the platform DB (control plane) to a regional runtime DB.
 *
 * Usage:
 *   tsx scripts/migrate-runtime-data.ts --region us-east-1 [--dry-run] [--verify]
 *
 * Requires:
 *   - NEON_PLATFORM_PRIMARY_URL (source — the control DB pre-cutover)
 *   - NEON_RUNTIME_PROJECT_ID_<REGION> (destination)
 *
 * For each table in RUNTIME_TABLES:
 *   - Counts rows in source.
 *   - With --dry-run: reports source/destination counts.
 *   - Otherwise: COPYs the table from source to destination.
 *   - With --verify: re-counts both and asserts equality.
 *
 * The script does NOT drop tables from source; that's a separate migration
 * (db/control-plane/061_post_cutover_drop_runtime_tables.sql).
 */

import pg from 'pg';

export const RUNTIME_TABLES = [
  // Order matters: parents before children for any same-tier FKs.
  'apps',
  'app_db_connections',
  'app_users',
  'app_refresh_tokens',
  'app_verification_codes',
  'app_signing_keys',
  'app_oauth_configs',
  'app_connected_accounts',
  'oauth_states',
  'app_custom_domains',
  'app_frontend_env_vars',
  'app_do_env_vars',
  'app_durable_objects',
  'app_do_deploy_state',
  'app_edge_ssr_deployments',
  'app_functions',
  'function_triggers',
  'function_invocations',
  'app_realtime_config',
  'app_integration_configs',
  'app_orders',
  'app_plans',
  'app_products',
  'app_subscriptions',
  'agents',
  'agent_mcp_servers',
  'agent_runs',
  'agent_run_events',
  'agent_checkpoints',
  'agent_tool_audits',
  'agent_usage',
  'agent_webhook_deliveries',
  'partner_keys',
  'partner_pools',
  'partner_proxy_logs',
  'mcp_tool_call_log',
  'ai_usage_logs',
  'dispatcher_cursors',
  'storage_objects',
  'app_deployments',
  'neon_tasks',
  'rag_ingestion_queue',
  'usage_meters',
];

export interface ParsedArgs {
  region: string;
  dryRun: boolean;
  verify: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const regionIdx = argv.indexOf('--region');
  if (regionIdx === -1 || regionIdx === argv.length - 1) {
    throw new Error('--region required (e.g. --region us-east-1)');
  }
  return {
    region: argv[regionIdx + 1],
    dryRun: argv.includes('--dry-run'),
    verify: argv.includes('--verify'),
  };
}

function regionToEnvSuffix(region: string): string {
  return region.toUpperCase().replace(/-/g, '_');
}

async function tableCount(client: pg.PoolClient, table: string): Promise<number> {
  const r = await client.query<{ c: number }>(`SELECT count(*)::int AS c FROM ${table}`);
  return r.rows[0].c;
}

async function copyTable(
  src: pg.PoolClient,
  dst: pg.PoolClient,
  table: string
): Promise<number> {
  // Use COPY for speed. pg-copy-streams would be ideal, but for Phase 2 (one-time
  // operation, hours-long maintenance window acceptable), straight INSERT is fine
  // and avoids a new dependency. Tables are typically <100k rows for runtime data.
  const result = await src.query(`SELECT * FROM ${table}`);
  const { rows, fields } = result;
  if (rows.length === 0) return 0;

  // Build a set of column names whose OID indicates jsonb/json so we can
  // re-serialise them before passing as query parameters (the pg driver parses
  // jsonb into JS objects on read, but the destination needs a JSON string).
  const JSON_OIDS = new Set([114, 3802]); // json = 114, jsonb = 3802
  const jsonCols = new Set(fields.filter((f) => JSON_OIDS.has(f.dataTypeID)).map((f) => f.name));

  const cols = Object.keys(rows[0]);
  const colList = cols.map((c) => `"${c}"`).join(',');
  const valuesList = rows
    .map((row, i) => '(' + cols.map((_, j) => `$${i * cols.length + j + 1}`).join(',') + ')')
    .join(',');
  const params = rows.flatMap((row) =>
    cols.map((c) => {
      const v = row[c];
      if (v !== null && v !== undefined && jsonCols.has(c)) {
        return typeof v === 'string' ? v : JSON.stringify(v);
      }
      return v;
    })
  );

  await dst.query(
    `INSERT INTO ${table} (${colList}) VALUES ${valuesList} ON CONFLICT DO NOTHING`,
    params
  );
  return rows.length;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourceUrl = process.env.NEON_PLATFORM_PRIMARY_URL;
  if (!sourceUrl) throw new Error('NEON_PLATFORM_PRIMARY_URL required (source DB)');

  const dstEnv = `NEON_RUNTIME_PROJECT_ID_${regionToEnvSuffix(args.region)}`;
  const destUrl = process.env[dstEnv];
  if (!destUrl) throw new Error(`${dstEnv} required (destination DB)`);

  console.log(`=== migrate-runtime-data ===`);
  console.log(`Source: ${sourceUrl.replace(/:[^@]+@/, ':***@')}`);
  console.log(`Dest:   ${destUrl.replace(/:[^@]+@/, ':***@')}`);
  console.log(`Region: ${args.region}`);
  console.log(`Mode:   ${args.dryRun ? 'DRY-RUN' : 'COPY'}${args.verify ? ' + VERIFY' : ''}`);
  console.log('');

  const srcPool = new pg.Pool({ connectionString: sourceUrl });
  const dstPool = new pg.Pool({ connectionString: destUrl });
  const src = await srcPool.connect();
  const dst = await dstPool.connect();

  try {
    let totalCopied = 0;
    for (const table of RUNTIME_TABLES) {
      const srcCount = await tableCount(src, table);
      const dstCountBefore = await tableCount(dst, table);

      if (args.dryRun) {
        console.log(`  ${table}: src=${srcCount}, dst=${dstCountBefore} (no copy)`);
        continue;
      }

      const copied = await copyTable(src, dst, table);
      totalCopied += copied;

      if (args.verify) {
        const dstCountAfter = await tableCount(dst, table);
        const expected = dstCountBefore + copied;
        const ok = dstCountAfter === srcCount;
        console.log(
          `  ${table}: src=${srcCount} copied=${copied} dst=${dstCountBefore}→${dstCountAfter} ${ok ? 'OK' : 'MISMATCH'}`
        );
        if (!ok) throw new Error(`Row count mismatch on ${table}`);
      } else {
        console.log(`  ${table}: copied ${copied} rows`);
      }
    }
    console.log('');
    console.log(`Total rows copied: ${totalCopied}`);
  } finally {
    src.release();
    dst.release();
    await srcPool.end();
    await dstPool.end();
  }
}

const isDirectInvocation = import.meta.url === `file://${process.argv[1]}`;
if (isDirectInvocation) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
