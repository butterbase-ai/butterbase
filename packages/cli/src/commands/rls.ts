import chalk from 'chalk';
import ora from 'ora';
import {
  listRlsPolicies,
  createUserIsolationPolicy,
  createRlsPolicy,
  enableRls,
  deleteRlsTablePolicies,
  deleteRlsPolicy,
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

export async function rlsListCommand(options: { app?: string; json?: boolean }) {
  const appId = await requireAppId(options.app);
  const spinner = ora('Fetching RLS policies...').start();
  try {
    const result: any = await listRlsPolicies(appId);
    spinner.stop();
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    const policies = result.policies ?? result ?? [];
    if (!Array.isArray(policies) || policies.length === 0) {
      console.log(chalk.gray('No RLS policies found.'));
      return;
    }
    console.log('');
    for (const p of policies) {
      console.log(`  ${chalk.cyan(p.table_name ?? p.tablename)}  ${chalk.bold(p.policy_name ?? p.policyname)}  ${chalk.gray(p.command ?? p.cmd ?? '')}`);
    }
    console.log('');
  } catch (err) {
    spinner.fail('Failed to fetch RLS policies');
    console.error(chalk.red((err as Error).message));
    process.exit(1);
  }
}

export async function rlsCreateCommand(options: {
  app?: string;
  json?: boolean;
  userIsolation?: boolean;
  table?: string;
  userColumn?: string;
  publicReadColumn?: string;
  policyName?: string;
  command?: string;
  using?: string;
  withCheck?: string;
  restrictive?: boolean;
  role?: 'anon' | 'user';
}) {
  const appId = await requireAppId(options.app);

  if (!options.table) {
    console.error(chalk.red('--table is required'));
    process.exit(1);
  }

  const spinner = ora('Creating RLS policy...').start();
  try {
    let result: any;
    if (options.userIsolation) {
      if (!options.userColumn) {
        spinner.fail('--user-column is required with --user-isolation');
        process.exit(1);
      }
      result = await createUserIsolationPolicy(appId, {
        table_name: options.table,
        user_column: options.userColumn,
        public_read_column: options.publicReadColumn,
      });
    } else {
      if (!options.policyName) {
        spinner.fail('--policy-name is required for custom policies');
        process.exit(1);
      }
      result = await createRlsPolicy(appId, {
        table_name: options.table,
        policy_name: options.policyName,
        command: options.command,
        role: options.role,
        using_expression: options.using,
        with_check_expression: options.withCheck,
        restrictive: options.restrictive,
        user_column: options.userColumn,
      });
    }
    spinner.succeed('RLS policy created');
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log('');
    console.log(`  Table:  ${chalk.cyan(options.table)}`);
    if (options.policyName) console.log(`  Policy: ${chalk.bold(options.policyName)}`);
    console.log('');
  } catch (err) {
    spinner.fail('Failed to create RLS policy');
    console.error(chalk.red((err as Error).message));
    process.exit(1);
  }
}

export async function rlsEnableCommand(table: string, options: { app?: string }) {
  const appId = await requireAppId(options.app);
  const spinner = ora(`Enabling RLS on ${table}...`).start();
  try {
    await enableRls(appId, table);
    spinner.succeed(`RLS enabled on ${chalk.cyan(table)}`);
  } catch (err) {
    spinner.fail('Failed to enable RLS');
    console.error(chalk.red((err as Error).message));
    process.exit(1);
  }
}

export async function rlsDeleteCommand(table: string, options: { app?: string; policy?: string }) {
  const appId = await requireAppId(options.app);
  const spinner = ora(options.policy ? `Deleting policy ${options.policy} on ${table}...` : `Deleting all policies on ${table}...`).start();
  try {
    if (options.policy) {
      await deleteRlsPolicy(appId, table, options.policy);
      spinner.succeed(`Deleted policy ${chalk.cyan(options.policy)} on ${chalk.cyan(table)}`);
    } else {
      await deleteRlsTablePolicies(appId, table);
      spinner.succeed(`Deleted all RLS policies on ${chalk.cyan(table)}`);
    }
  } catch (err) {
    spinner.fail('Failed to delete RLS policy');
    console.error(chalk.red((err as Error).message));
    process.exit(1);
  }
}
