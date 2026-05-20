import chalk from 'chalk';
import ora from 'ora';
import fs from 'fs-extra';
import dotenv from 'dotenv';
import { setFrontendEnv, getFrontendEnv } from '../lib/api-client.js';
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

export async function envSetCommand(vars: string[], options: { app?: string }) {
  const appId = await requireAppId(options.app);

  const envVars: Record<string, string> = {};
  for (const v of vars) {
    const idx = v.indexOf('=');
    if (idx === -1) {
      console.error(chalk.red(`Invalid format: "${v}". Use KEY=VALUE`));
      process.exit(1);
    }
    envVars[v.slice(0, idx)] = v.slice(idx + 1);
  }

  const spinner = ora('Setting environment variables...').start();

  try {
    await setFrontendEnv(appId, envVars);
    spinner.succeed('Environment variables updated');
    console.log(`\n  Keys set: ${chalk.white(Object.keys(envVars).join(', '))}`);
  } catch (error) {
    spinner.fail('Failed to set environment variables');
    console.error(chalk.red((error as Error).message));
    process.exit(1);
  }
}

export async function envListCommand(options: { app?: string; json?: boolean }) {
  const appId = await requireAppId(options.app);
  const spinner = ora('Fetching environment variables...').start();

  try {
    const result = await getFrontendEnv(appId);
    spinner.stop();

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (!result.envVars || result.envVars.length === 0) {
      console.log(chalk.yellow('No frontend environment variables set'));
      return;
    }

    console.log(chalk.white('Frontend environment variables:\n'));
    for (const v of result.envVars) {
      console.log(`  ${chalk.white(v.key.padEnd(30))} ${chalk.gray('set ' + v.updatedAt?.slice(0, 10))}`);
    }
    console.log(chalk.gray(`\n(${result.envVars.length} variable${result.envVars.length === 1 ? '' : 's'})`));
  } catch (error) {
    spinner.fail('Failed to list environment variables');
    console.error(chalk.red((error as Error).message));
    process.exit(1);
  }
}

export async function envSetFileCommand(filePath: string, options: { app?: string }) {
  const appId = await requireAppId(options.app);

  if (!await fs.pathExists(filePath)) {
    console.error(chalk.red(`File not found: ${filePath}`));
    process.exit(1);
  }

  const content = await fs.readFile(filePath, 'utf-8');
  const envVars = dotenv.parse(content);

  if (Object.keys(envVars).length === 0) {
    console.log(chalk.yellow('No variables found in file'));
    return;
  }

  const spinner = ora(`Setting ${Object.keys(envVars).length} environment variables...`).start();

  try {
    await setFrontendEnv(appId, envVars);
    spinner.succeed('Environment variables updated');
    console.log(`\n  Keys set: ${chalk.white(Object.keys(envVars).join(', '))}`);
  } catch (error) {
    spinner.fail('Failed to set environment variables');
    console.error(chalk.red((error as Error).message));
    process.exit(1);
  }
}
