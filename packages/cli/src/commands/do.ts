import chalk from 'chalk';
import ora from 'ora';
import fs from 'fs-extra';
import path from 'path';
import {
  createDurableObject,
  listDurableObjects,
  getDurableObject,
  deleteDurableObject,
  getDoUsage,
  listDoEnv,
  setDoEnv,
  deleteDoEnv,
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

export async function doDeployCommand(file: string, options: { app?: string; name?: string; accessMode?: string; json?: boolean }) {
  const appId = await requireAppId(options.app);
  const filePath = path.resolve(file);
  if (!fs.existsSync(filePath)) {
    console.error(chalk.red(`File not found: ${filePath}`));
    process.exit(1);
  }
  const code = fs.readFileSync(filePath, 'utf-8');
  const name = options.name || path.basename(filePath, path.extname(filePath));
  const accessMode = options.accessMode || 'authenticated';

  const spinner = ora(`Deploying DO ${name}...`).start();
  try {
    const result = await createDurableObject(appId, name, code, accessMode);
    spinner.succeed(`Deployed!`);
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log('');
    console.log(`  Name:    ${chalk.cyan((result as any).name)}`);
    console.log(`  Status:  ${chalk.green((result as any).status)}`);
    console.log(`  ID:      ${(result as any).id}`);
    console.log(`  URL:     https://<subdomain>.butterbase.dev/_do/${(result as any).name}/<instance-id>`);
  } catch (err) {
    spinner.fail('Deploy failed');
    console.error(chalk.red((err as Error).message));
    process.exit(1);
  }
}

export async function doListCommand(options: { app?: string; json?: boolean }) {
  const appId = await requireAppId(options.app);
  const result = await listDurableObjects(appId);
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const dos = (result as any).durable_objects as Array<any>;
  if (dos.length === 0) {
    console.log(chalk.gray('No Durable Objects registered.'));
    return;
  }
  console.log('');
  for (const d of dos) {
    console.log(`  ${chalk.cyan(d.name)}  ${chalk.gray(d.class_name)}  ${d.status === 'READY' ? chalk.green(d.status) : chalk.yellow(d.status)}`);
    if (d.error_message) console.log(chalk.red(`    error: ${d.error_message}`));
  }
}

export async function doGetCommand(name: string, options: { app?: string; json?: boolean; code?: boolean }) {
  const appId = await requireAppId(options.app);
  const result = await getDurableObject(appId, name);
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (options.code) {
    console.log((result as any).code);
    return;
  }
  console.log('');
  console.log(`  Name:        ${chalk.cyan((result as any).name)}`);
  console.log(`  Class:       ${(result as any).class_name}`);
  console.log(`  Status:      ${(result as any).status}`);
  console.log(`  Access mode: ${(result as any).access_mode}`);
  console.log(`  Last deploy: ${(result as any).last_deployed_at ?? '(never)'}`);
  if ((result as any).error_message) console.log(chalk.red(`  Error: ${(result as any).error_message}`));
}

export async function doDeleteCommand(name: string, options: { app?: string }) {
  const appId = await requireAppId(options.app);
  const spinner = ora(`Deleting DO ${name}...`).start();
  try {
    await deleteDurableObject(appId, name);
    spinner.succeed(`Deleted ${name}`);
  } catch (err) {
    spinner.fail('Delete failed');
    console.error(chalk.red((err as Error).message));
    process.exit(1);
  }
}

export async function doEnvListCommand(options: { app?: string; json?: boolean }) {
  const appId = await requireAppId(options.app);
  const result = await listDoEnv(appId);
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (result.keys.length === 0) {
    console.log(chalk.gray('No DO env vars set.'));
    return;
  }
  console.log('');
  for (const k of result.keys) console.log(`  ${chalk.cyan(k)}`);
  console.log('');
  console.log(chalk.gray('  (values are write-only — set with `butterbase do env set KEY VALUE`)'));
}

export async function doEnvSetCommand(key: string, value: string, options: { app?: string }) {
  const appId = await requireAppId(options.app);
  const spinner = ora(`Setting ${key}…`).start();
  try {
    const result = await setDoEnv(appId, key, value);
    if (result.redeployed) {
      spinner.succeed(`Set ${chalk.cyan(key)} and redeployed DO Worker`);
    } else {
      spinner.succeed(`Set ${chalk.cyan(key)} ${chalk.gray('(no active DO classes — value will apply on next deploy)')}`);
    }
  } catch (err) {
    spinner.fail(`Failed to set ${key}`);
    console.error(chalk.red((err as Error).message));
    process.exit(1);
  }
}

export async function doEnvUnsetCommand(key: string, options: { app?: string }) {
  const appId = await requireAppId(options.app);
  const spinner = ora(`Removing ${key}…`).start();
  try {
    const result = await deleteDoEnv(appId, key);
    if (result.redeployed) {
      spinner.succeed(`Removed ${chalk.cyan(key)} and redeployed DO Worker`);
    } else {
      spinner.succeed(`Removed ${chalk.cyan(key)}`);
    }
  } catch (err) {
    spinner.fail(`Failed to remove ${key}`);
    console.error(chalk.red((err as Error).message));
    process.exit(1);
  }
}

export async function doUsageCommand(name: string, options: { app?: string; json?: boolean }) {
  const appId = await requireAppId(options.app);
  const result = await getDoUsage(appId, name);
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log('');
  console.log(chalk.gray('  Note: v1 metering reports app-wide DO totals (per-class breakdown coming in v2).'));
  console.log(`  Requests:        ${(result as any).do_requests.toLocaleString()}`);
  console.log(`  CPU ms:          ${(result as any).do_cpu_ms.toLocaleString()}`);
}
