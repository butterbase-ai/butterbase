import chalk from 'chalk';
import ora from 'ora';
import { configureRealtime, getRealtimeConfig, disableRealtime } from '../lib/api-client.js';
import { getCurrentAppId } from '../lib/config.js';

async function requireAppId(appId?: string): Promise<string> {
  if (appId) return appId;

  const currentAppId = await getCurrentAppId();
  if (!currentAppId) {
    console.log(chalk.red('✗ No app specified and no current app set'));
    console.log(chalk.gray('Use: butterbase apps use <app-id>'));
    process.exit(1);
  }

  return currentAppId;
}

export async function realtimeEnableCommand(tables: string[], options: { app?: string }) {
  const appId = await requireAppId(options.app);

  if (tables.length === 0) {
    console.log(chalk.red('✗ Specify at least one table'));
    process.exit(1);
  }

  const spinner = ora(`Enabling realtime on ${tables.join(', ')}...`).start();

  try {
    const response: any = await configureRealtime(appId, tables);
    spinner.succeed('Realtime enabled');

    console.log();
    for (const item of response.configured) {
      console.log(chalk.green(`  ✓ ${item.table} — ${item.status}`));
    }
    console.log();
  } catch (error) {
    spinner.fail('Failed to enable realtime');
    console.error(chalk.red((error as Error).message));
    process.exit(1);
  }
}

export async function realtimeConfigCommand(options: { app?: string; json?: boolean }) {
  const appId = await requireAppId(options.app);
  const spinner = ora('Fetching realtime config...').start();

  try {
    const response: any = await getRealtimeConfig(appId);
    spinner.stop();

    if (options.json) {
      console.log(JSON.stringify(response, null, 2));
      return;
    }

    console.log(chalk.blue('\nRealtime Configuration\n'));
    console.log(chalk.gray(`  WebSocket URL: ${response.websocket_url}`));
    console.log(chalk.gray(`  Active connection: ${response.active_connection ? chalk.green('yes') : 'no'}`));

    if (!response.tables || response.tables.length === 0) {
      console.log(chalk.yellow('\n  No tables configured for realtime'));
    } else {
      console.log(chalk.gray('\n  Tables:'));
      for (const table of response.tables) {
        const status = table.enabled ? chalk.green('enabled') : chalk.red('disabled');
        console.log(`    ${chalk.bold(table.table_name)} — ${status}`);
      }
    }
    console.log();
  } catch (error) {
    spinner.fail('Failed to fetch realtime config');
    console.error(chalk.red((error as Error).message));
    process.exit(1);
  }
}

export async function realtimeDisableCommand(table: string, options: { app?: string }) {
  const appId = await requireAppId(options.app);
  const spinner = ora(`Disabling realtime on "${table}"...`).start();

  try {
    await disableRealtime(appId, table);
    spinner.succeed(`Disabled realtime on "${table}"`);
  } catch (error) {
    spinner.fail('Failed to disable realtime');
    console.error(chalk.red((error as Error).message));
    process.exit(1);
  }
}
