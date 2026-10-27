import { text, msg } from '../lib/i18n.js';
import chalk from 'chalk';
import ora from 'ora';
import fs from 'fs-extra';
import { getSchema, applySchema } from '../lib/api-client.js';
import { getCurrentAppId } from '../lib/config.js';

async function requireAppId(appId?: string): Promise<string> {
  if (appId) return appId;

  const currentAppId = await getCurrentAppId();
  if (!currentAppId) {
    console.log(chalk.red(text('✗ No app specified and no current app set')));
    console.log(chalk.gray(text('Use: butterbase apps use <app-id>')));
    console.log(chalk.gray(text('Or: butterbase schema get --app <app-id>')));
    process.exit(1);
  }

  return currentAppId;
}

export async function schemaGetCommand(options: { app?: string; output?: string }) {
  const appId = await requireAppId(options.app);
  const spinner = ora(text('Fetching schema...')).start();

  try {
    const response: any = await getSchema(appId);
    spinner.stop();

    const schemaJson = JSON.stringify(response.schema, null, 2);

    if (options.output) {
      await fs.writeFile(options.output, schemaJson);
      console.log(chalk.green(msg`✓ Schema saved to ${options.output}`));
    } else {
      console.log(schemaJson);
    }
  } catch (error) {
    spinner.fail(text('Failed to fetch schema'));
    console.error(chalk.red((error as Error).message));
    process.exit(1);
  }
}

export async function schemaApplyCommand(file: string, options: { app?: string; dryRun?: boolean; name?: string }) {
  const appId = await requireAppId(options.app);

  if (!await fs.pathExists(file)) {
    console.log(chalk.red(msg`✗ File not found: ${file}`));
    process.exit(1);
  }

  const spinner = ora(text('Reading schema file...')).start();

  try {
    const schemaContent = await fs.readFile(file, 'utf-8');
    const schema = JSON.parse(schemaContent);

    spinner.text = options.dryRun ? text('Running dry-run...') : text('Applying schema...');

    const response: any = await applySchema(appId, schema, options.dryRun, options.name);

    spinner.stop();

    if (options.dryRun) {
      console.log(chalk.blue(text('\n📋 Dry-run results:\n')));
      console.log(JSON.stringify(response, null, 2));
    } else {
      console.log(chalk.green(text('\n✓ Schema applied successfully!')));
      if (response.migration_id) {
        console.log(chalk.gray(msg`  Migration ID: ${response.migration_id}`));
      }
    }
  } catch (error) {
    spinner.fail(options.dryRun ? text('Dry-run failed') : text('Failed to apply schema'));
    console.error(chalk.red((error as Error).message));
    process.exit(1);
  }
}
