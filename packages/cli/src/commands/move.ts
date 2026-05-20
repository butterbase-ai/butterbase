import chalk from 'chalk';
import ora from 'ora';
import {
  moveApp, getMigration, getActiveMigration, abortMigration, reverseMigration,
  listSourceReplicas, tearDownSourceReplica, listRegions,
} from '../lib/api-client.js';
import { getCurrentAppId } from '../lib/config.js';

async function requireAppId(appId?: string): Promise<string> {
  if (appId) return appId;
  const current = await getCurrentAppId();
  if (!current) {
    console.log(chalk.red('No app specified and no current app set'));
    console.log(chalk.gray('Use: butterbase apps use <app-id>'));
    process.exit(1);
  }
  return current;
}

export async function moveCommand(
  appId: string | undefined,
  destRegion: string,
  options: { app?: string; follow?: boolean; json?: boolean },
) {
  const resolvedApp = await requireAppId(appId ?? options.app);
  // Validate region client-side
  try {
    const reg: any = await listRegions();
    if (!reg.regions?.includes(destRegion)) {
      console.log(chalk.red(`Unknown region '${destRegion}'. Valid: ${(reg.regions ?? []).join(', ')}`));
      process.exit(1);
    }
  } catch (e) {
    console.log(chalk.yellow(`Could not validate region (proceeding anyway): ${(e as Error).message}`));
  }
  const spinner = ora(`Starting migration to ${destRegion}...`).start();
  let migrationId: string;
  try {
    const r: any = await moveApp(resolvedApp, destRegion);
    spinner.succeed(`Migration started: ${r.migration_id} (${r.status})`);
    if (options.json) console.log(JSON.stringify(r, null, 2));
    migrationId = r.migration_id;
  } catch (e) {
    spinner.fail('Move failed');
    console.error(chalk.red((e as Error).message));
    process.exit(1);
  }
  if (!options.follow) return;
  const TERMINAL = new Set(['completed', 'aborted', 'failed']);
  while (true) {
    await new Promise((res) => setTimeout(res, 3000));
    try {
      const s: any = await getMigration(resolvedApp, migrationId);
      process.stdout.write(`\r[${s.current_step}]                        `);
      if (TERMINAL.has(s.current_step)) {
        process.stdout.write('\n');
        if (s.current_step === 'completed') {
          console.log(chalk.green(`✓ Migration complete (source replica retained — teardown with: butterbase apps replicas teardown ${migrationId})`));
        } else {
          console.log(chalk.red(`✗ Migration ${s.current_step}${s.last_error ? `: ${s.last_error}` : ''}`));
        }
        break;
      }
    } catch (e) {
      process.stdout.write('\n');
      console.error(chalk.red((e as Error).message));
      break;
    }
  }
}

export async function migrationStatusCommand(appId: string, migrationId: string, options: { json?: boolean }) {
  try {
    const r = await getMigration(appId, migrationId);
    console.log(options.json ? JSON.stringify(r, null, 2) : r);
  } catch (e) {
    console.error(chalk.red((e as Error).message));
    process.exit(1);
  }
}

export async function migrationActiveCommand(appId: string | undefined, options: { app?: string; json?: boolean }) {
  const resolvedApp = await requireAppId(appId ?? options.app);
  try {
    const r: any = await getActiveMigration(resolvedApp);
    if (options.json) return console.log(JSON.stringify(r, null, 2));
    if (!r.migration) {
      console.log(chalk.gray('No active migration.'));
      return;
    }
    console.log(`${r.migration.id}  step=${r.migration.current_step}  ${r.migration.source_region}→${r.migration.dest_region}`);
  } catch (e) {
    console.error(chalk.red((e as Error).message));
    process.exit(1);
  }
}

export async function migrationAbortCommand(appId: string, migrationId: string, options: { json?: boolean }) {
  const spinner = ora('Aborting migration...').start();
  try {
    const r = await abortMigration(appId, migrationId);
    spinner.succeed('Abort requested');
    if (options.json) console.log(JSON.stringify(r, null, 2));
  } catch (e) {
    spinner.fail('Abort failed');
    console.error(chalk.red((e as Error).message));
    process.exit(1);
  }
}

export async function migrationReverseCommand(appId: string, migrationId: string, options: { json?: boolean }) {
  const spinner = ora('Reversing migration...').start();
  try {
    const r = await reverseMigration(appId, migrationId);
    spinner.succeed('Reverse migration enqueued');
    if (options.json) console.log(JSON.stringify(r, null, 2));
  } catch (e) {
    spinner.fail('Reverse failed');
    console.error(chalk.red((e as Error).message));
    process.exit(1);
  }
}

export async function replicasListCommand(options: { json?: boolean }) {
  try {
    const r: any = await listSourceReplicas();
    if (options.json) return console.log(JSON.stringify(r, null, 2));
    const list = r.source_replicas ?? [];
    if (list.length === 0) {
      console.log(chalk.gray('No retained source replicas.'));
      return;
    }
    for (const sr of list) {
      console.log(`${sr.migration_id}  app=${sr.app_id}  ${sr.source_region}→${sr.dest_region}  state=${sr.state}`);
    }
  } catch (e) {
    console.error(chalk.red((e as Error).message));
    process.exit(1);
  }
}

export async function replicaTeardownCommand(migrationId: string, options: { json?: boolean }) {
  const spinner = ora('Tearing down source replica...').start();
  try {
    const r = await tearDownSourceReplica(migrationId);
    spinner.succeed('Source replica torn down');
    if (options.json) console.log(JSON.stringify(r, null, 2));
  } catch (e) {
    spinner.fail('Teardown failed');
    console.error(chalk.red((e as Error).message));
    process.exit(1);
  }
}
