#!/usr/bin/env tsx
/**
 * Operator-facing CLI for platform DB failover.
 *
 * Subcommands:
 *   status    - Show current active side, primary/standby connectivity, replication lag
 *   promote   - Promote standby to primary, swap Fly secrets, rolling restart
 *   failback  - Reverse direction (after primary region recovers)
 *
 * Examples:
 *   tsx scripts/failover-platform-db.ts status
 *   tsx scripts/failover-platform-db.ts promote --yes
 */

import pg from 'pg';
import { promoteReplicaToPrimary, getReplicationLagSeconds } from './lib/neon-failover.js';
import { setFlySecret, restartFlyApp } from './lib/fly-secrets.js';
import { confirm } from './lib/failover-prompts.js';

export type Subcommand = 'status' | 'promote' | 'failback';

export interface ParsedArgs {
  subcommand: Subcommand;
  yes: boolean;
}

const VALID_SUBCOMMANDS: ReadonlySet<Subcommand> = new Set(['status', 'promote', 'failback']);

const PLATFORM_FLY_APPS = (process.env.PLATFORM_FLY_APPS ?? 'butterbase-platform')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export function parseArgs(argv: string[]): ParsedArgs {
  if (argv.length === 0) {
    throw new Error('subcommand required (one of: status, promote, failback)');
  }
  const sub = argv[0];
  if (!VALID_SUBCOMMANDS.has(sub as Subcommand)) {
    throw new Error(`unknown subcommand "${sub}". Expected: status, promote, failback`);
  }
  const yes = argv.includes('--yes');
  return { subcommand: sub as Subcommand, yes };
}

interface DbProbeResult {
  url: string;
  reachable: boolean;
  isInRecovery: boolean | null;
  error: string | null;
  serverVersion: string | null;
}

async function probeDb(url: string): Promise<DbProbeResult> {
  if (!url) {
    return { url, reachable: false, isInRecovery: null, error: 'URL is empty', serverVersion: null };
  }
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  let connected = false;
  try {
    await client.connect();
    connected = true;
    const recovery = await client.query('SELECT pg_is_in_recovery() AS r');
    const version = await client.query('SHOW server_version');
    return {
      url,
      reachable: true,
      isInRecovery: recovery.rows[0]?.r === true,
      error: null,
      serverVersion: version.rows[0]?.server_version ?? null,
    };
  } catch (err) {
    return {
      url,
      reachable: false,
      isInRecovery: null,
      error: (err as Error).message,
      serverVersion: null,
    };
  } finally {
    // Only call end() if connect() succeeded — calling end() on a never-connected
    // client throws and would mask the original error.
    if (connected) {
      try { await client.end(); } catch { /* best-effort cleanup */ }
    }
  }
}

async function runStatus(): Promise<void> {
  const primaryUrl = process.env.NEON_PLATFORM_PRIMARY_URL ?? '';
  const standbyUrl = process.env.NEON_PLATFORM_STANDBY_URL ?? '';
  const activeSide = process.env.PLATFORM_DB_ACTIVE_SIDE ?? 'primary';

  console.log('Platform DB Status');
  console.log('==================');
  console.log(`Active side (env): ${activeSide}`);
  console.log('');

  console.log('Primary:');
  const primary = await probeDb(primaryUrl);
  console.log(`  URL set: ${primaryUrl ? 'yes' : 'no'}`);
  console.log(`  Reachable: ${primary.reachable}`);
  if (primary.reachable) {
    console.log(`  In recovery (replica?): ${primary.isInRecovery}`);
    console.log(`  Server version: ${primary.serverVersion}`);
  } else {
    console.log(`  Error: ${primary.error}`);
  }

  console.log('');
  console.log('Standby:');
  const standby = await probeDb(standbyUrl);
  console.log(`  URL set: ${standbyUrl ? 'yes' : 'no'}`);
  console.log(`  Reachable: ${standby.reachable}`);
  if (standby.reachable) {
    console.log(`  In recovery (replica?): ${standby.isInRecovery}`);
    console.log(`  Server version: ${standby.serverVersion}`);
  } else {
    console.log(`  Error: ${standby.error}`);
  }

  console.log('');
  // Sanity warnings
  if (primary.reachable && primary.isInRecovery === true) {
    console.log('⚠️  Primary URL points at a database in recovery mode. Did failover happen but env not updated?');
  }
  if (standby.reachable && standby.isInRecovery === false) {
    console.log('⚠️  Standby URL points at a database NOT in recovery. Was the standby already promoted?');
  }
}

async function runPromote(yes: boolean): Promise<void> {
  const apiKey = process.env.NEON_API_KEY;
  const standbyProjectId = process.env.NEON_PLATFORM_STANDBY_PROJECT_ID;
  const standbyUrl = process.env.NEON_PLATFORM_STANDBY_URL;

  if (!apiKey) throw new Error('NEON_API_KEY env var required');
  if (!standbyProjectId) throw new Error('NEON_PLATFORM_STANDBY_PROJECT_ID env var required');
  if (!standbyUrl) throw new Error('NEON_PLATFORM_STANDBY_URL env var required');

  console.log('=== Platform DB Promote ===');
  console.log(`Standby project: ${standbyProjectId}`);
  console.log(`Standby URL: ${standbyUrl.replace(/:[^@]+@/, ':***@')}`);
  console.log(`Fly apps to restart: ${PLATFORM_FLY_APPS.join(', ')}`);
  console.log('');
  console.log('This will:');
  console.log('  1. Promote the standby Neon project to read-write (irreversible without re-replication)');
  console.log('  2. Stage PLATFORM_DB_ACTIVE_SIDE=standby on each Fly app');
  console.log('  3. Restart each Fly app to pick up the new active side');
  console.log('  4. Verify a synthetic write succeeds against the promoted DB');
  console.log('');

  if (!yes) {
    const confirmed = await confirm('Proceed with promotion?');
    if (!confirmed) {
      console.log('Aborted.');
      process.exit(2);
    }
  }

  console.log('Step 1: Checking replication lag...');
  const lag = await getReplicationLagSeconds(standbyUrl);
  if (lag === null) {
    console.log('  Lag: unmeasurable (replica may have already been promoted, or never replicated). Proceeding anyway.');
  } else {
    console.log(`  Lag: ${lag.toFixed(2)} seconds`);
    if (lag > 30) {
      console.log(`  ⚠️  Lag is high (${lag.toFixed(2)}s). Some recent writes may not yet be on the standby.`);
      if (!yes) {
        const ack = await confirm('Continue despite high lag?');
        if (!ack) { console.log('Aborted.'); process.exit(2); }
      }
    }
  }

  console.log('Step 2: Promoting Neon standby...');
  await promoteReplicaToPrimary({ apiKey, projectId: standbyProjectId });
  console.log('  Promoted.');

  console.log('Step 3: Staging Fly secret PLATFORM_DB_ACTIVE_SIDE=standby...');
  for (const app of PLATFORM_FLY_APPS) {
    await setFlySecret({ app, key: 'PLATFORM_DB_ACTIVE_SIDE', value: 'standby', stage: true });
    console.log(`  Staged on ${app}`);
  }

  console.log('Step 4: Restarting Fly apps to pick up the new secret...');
  for (const app of PLATFORM_FLY_APPS) {
    await restartFlyApp({ app });
    console.log(`  Restarted ${app}`);
  }

  console.log('Step 5: Verifying a synthetic write against the promoted DB...');
  const probeClient = new pg.Client({ connectionString: standbyUrl });
  await probeClient.connect();
  try {
    await probeClient.query(`
      CREATE TABLE IF NOT EXISTS _failover_drill (
        id SERIAL PRIMARY KEY,
        action TEXT NOT NULL,
        at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await probeClient.query(`INSERT INTO _failover_drill (action) VALUES ('promote')`);
    console.log('  Synthetic write succeeded.');
  } finally {
    await probeClient.end();
  }

  console.log('');
  console.log('✅ Promotion complete. Standby is now the active platform DB.');
  console.log('   Active side env var: standby');
  console.log('   Run `failover-platform-db.ts status` to verify.');
  console.log('   When the original primary recovers, run `failback` to switch back.');
}

async function runFailback(yes: boolean): Promise<void> {
  const primaryUrl = process.env.NEON_PLATFORM_PRIMARY_URL;
  if (!primaryUrl) throw new Error('NEON_PLATFORM_PRIMARY_URL env var required');

  console.log('=== Platform DB Failback ===');
  console.log('');
  console.log('PREREQUISITE: The original primary must already be set up as a fresh replica');
  console.log('  of the currently-active (formerly-standby) DB, via the Neon console or a setup script.');
  console.log('  Confirm replication lag is < 5s before continuing.');
  console.log('');
  console.log('This will:');
  console.log('  1. Verify replication is caught up on the original primary URL');
  console.log('  2. Promote the original primary back to read-write via Neon');
  console.log('  3. Stage PLATFORM_DB_ACTIVE_SIDE=primary on each Fly app');
  console.log('  4. Restart Fly apps');
  console.log('  5. Verify writes succeed against the failed-back primary');
  console.log('');

  if (!yes) {
    const confirmed = await confirm('Proceed with failback?');
    if (!confirmed) { console.log('Aborted.'); process.exit(2); }
  }

  console.log('Step 1: Checking replication lag on original primary URL...');
  const lag = await getReplicationLagSeconds(primaryUrl);
  if (lag === null) {
    throw new Error('Could not measure lag on primary URL. It may not be set up as a replica yet.');
  }
  console.log(`  Lag: ${lag.toFixed(2)} seconds`);
  if (lag > 5) {
    if (!yes) {
      const ack = await confirm(`Lag is ${lag.toFixed(2)}s — proceed anyway?`);
      if (!ack) { console.log('Aborted.'); process.exit(2); }
    }
  }

  const apiKey = process.env.NEON_API_KEY;
  const primaryProjectId = process.env.NEON_PLATFORM_PROJECT_ID;
  if (!apiKey) throw new Error('NEON_API_KEY env var required');
  if (!primaryProjectId) throw new Error('NEON_PLATFORM_PROJECT_ID env var required');

  console.log('Step 2: Promoting original primary back to read-write...');
  await promoteReplicaToPrimary({ apiKey, projectId: primaryProjectId });
  console.log('  Promoted.');

  console.log('Step 3: Staging Fly secret PLATFORM_DB_ACTIVE_SIDE=primary...');
  for (const app of PLATFORM_FLY_APPS) {
    await setFlySecret({ app, key: 'PLATFORM_DB_ACTIVE_SIDE', value: 'primary', stage: true });
    console.log(`  Staged on ${app}`);
  }

  console.log('Step 4: Restarting Fly apps...');
  for (const app of PLATFORM_FLY_APPS) {
    await restartFlyApp({ app });
    console.log(`  Restarted ${app}`);
  }

  console.log('Step 5: Verifying writes against the failed-back primary...');
  const probeClient = new pg.Client({ connectionString: primaryUrl });
  await probeClient.connect();
  try {
    await probeClient.query(`
      CREATE TABLE IF NOT EXISTS _failover_drill (
        id SERIAL PRIMARY KEY,
        action TEXT NOT NULL,
        at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await probeClient.query(`INSERT INTO _failover_drill (action) VALUES ('failback')`);
    console.log('  Synthetic write succeeded.');
  } finally {
    await probeClient.end();
  }

  console.log('');
  console.log('✅ Failback complete. Primary is once again the active platform DB.');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  switch (args.subcommand) {
    case 'status':
      await runStatus();
      break;
    case 'promote':
      await runPromote(args.yes);
      break;
    case 'failback':
      await runFailback(args.yes);
      break;
  }
}

const isDirectInvocation = import.meta.url === `file://${process.argv[1]}`;
if (isDirectInvocation) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
