import chalk from 'chalk';
import ora from 'ora';
import { getAppConfig, getSchema, listFunctions, listDeployments, getFrontendEnv } from '../lib/api-client.js';
import { getCurrentAppId } from '../lib/config.js';

async function requireAppId(appId?: string): Promise<string> {
  if (appId) return appId;
  const currentAppId = await getCurrentAppId();
  if (!currentAppId) {
    console.log(chalk.red('No app specified and no current app set'));
    console.log(chalk.gray('Use: butterbase apps use <app-id>'));
    process.exit(1);
  }
  return currentAppId;
}

export async function statusCommand(options: { app?: string; json?: boolean }) {
  const appId = await requireAppId(options.app);
  const spinner = ora('Fetching app status...').start();

  try {
    const [config, schema, funcs, deploys, env] = await Promise.all([
      getAppConfig(appId).catch(() => null),
      getSchema(appId).catch(() => null),
      listFunctions(appId).catch(() => null),
      listDeployments(appId).catch(() => null),
      getFrontendEnv(appId).catch(() => null),
    ]);

    spinner.stop();

    if (options.json) {
      console.log(JSON.stringify({ config, schema, functions: funcs, deployments: deploys, env }, null, 2));
      return;
    }

    // App info
    const name = (config as any)?.name || appId;
    const region = (config as any)?.region || 'unknown';
    console.log(chalk.white.bold(`${name}`) + chalk.gray(` (${appId})`));
    console.log(chalk.gray(`Region: ${region}\n`));

    // Database
    const tables = (schema as any)?.schema?.tables;
    if (tables) {
      const tableNames = Object.keys(tables);
      console.log(chalk.blue('Database:'));
      if (tableNames.length === 0) {
        console.log(chalk.gray('  No tables'));
      } else {
        console.log(`  Tables: ${tableNames.join(', ')} ${chalk.gray(`(${tableNames.length})`)}`);
      }
      console.log('');
    }

    // Frontend
    const deployList = (deploys as any)?.deployments || [];
    const latest = deployList[0];
    console.log(chalk.blue('Frontend:'));
    if (latest) {
      const statusColor = latest.status === 'READY' ? chalk.green : latest.status === 'ERROR' ? chalk.red : chalk.yellow;
      console.log(`  URL: ${chalk.white(latest.url || 'n/a')}`);
      console.log(`  Last deploy: ${statusColor(latest.status)} ${chalk.gray(latest.createdAt?.slice(0, 10) || '')}`);
    } else {
      console.log(chalk.gray('  No deployments'));
    }

    // Env vars
    const envVars = (env as any)?.envVars || [];
    if (envVars.length > 0) {
      console.log(`  Env vars: ${envVars.map((e: any) => e.key).join(', ')}`);
    }
    console.log('');

    // Functions
    const funcList = (funcs as any)?.functions || [];
    console.log(chalk.blue('Functions:'));
    if (funcList.length === 0) {
      console.log(chalk.gray('  None deployed'));
    } else {
      for (const f of funcList) {
        // After the function_triggers cutover the API returns a `triggers`
        // array; fall back to the legacy single field for older servers.
        const types: string[] = Array.isArray(f.triggers)
          ? f.triggers.map((t: { type: string }) => t.type)
          : f.trigger_type
            ? [f.trigger_type]
            : ['http'];
        console.log(`  ${chalk.white(f.name)} ${chalk.gray(`(${types.join(', ')})`)}`);
      }
    }
    console.log('');

    // CORS
    const origins = (config as any)?.allowed_origins || [];
    console.log(chalk.blue('CORS:'));
    if (origins.length === 0) {
      console.log(chalk.gray('  No origins configured'));
    } else {
      for (const o of origins) console.log(`  ${o}`);
    }
  } catch (error) {
    spinner.fail('Failed to fetch app status');
    console.error(chalk.red((error as Error).message));
    process.exit(1);
  }
}
