import chalk from 'chalk';
import ora from 'ora';
import fs from 'fs-extra';
import { getSchema, applySchema } from '../lib/api-client.js';
import { getCurrentAppId } from '../lib/config.js';

async function requireAppId(appId?: string): Promise<string> {
  if (appId) return appId;

  const currentAppId = await getCurrentAppId();
  if (!currentAppId) {
    console.log(chalk.red('✗ No app specified and no current app set'));
    console.log(chalk.gray('Use: butterbase apps use <app-id>'));
    console.log(chalk.gray('Or: butterbase schema get --app <app-id>'));
    process.exit(1);
  }

  return currentAppId;
}

export async function schemaGetCommand(options: { app?: string; output?: string }) {
  const appId = await requireAppId(options.app);
  const spinner = ora('Fetching schema...').start();

  try {
    const response: any = await getSchema(appId);
    spinner.stop();

    const schemaJson = JSON.stringify(response.schema, null, 2);

    if (options.output) {
      await fs.writeFile(options.output, schemaJson);
      console.log(chalk.green(`✓ Schema saved to ${options.output}`));
    } else {
      console.log(schemaJson);
    }
  } catch (error) {
    spinner.fail('Failed to fetch schema');
    console.error(chalk.red((error as Error).message));
    process.exit(1);
  }
}

export async function schemaApplyCommand(file: string, options: { app?: string; dryRun?: boolean; name?: string }) {
  const appId = await requireAppId(options.app);

  if (!await fs.pathExists(file)) {
    console.log(chalk.red(`✗ File not found: ${file}`));
    process.exit(1);
  }

  const spinner = ora('Reading schema file...').start();

  try {
    const schemaContent = await fs.readFile(file, 'utf-8');
    const schema = JSON.parse(schemaContent);

    spinner.text = options.dryRun ? 'Running dry-run...' : 'Applying schema...';

    const response: any = await applySchema(appId, schema, options.dryRun, options.name);

    spinner.stop();

    if (options.dryRun) {
      console.log(chalk.blue('\n📋 Dry-run results:\n'));
      console.log(JSON.stringify(response, null, 2));
    } else {
      console.log(chalk.green('\n✓ Schema applied successfully!'));
      if (response.migration_id) {
        console.log(chalk.gray(`  Migration ID: ${response.migration_id}`));
      }
    }
  } catch (error) {
    spinner.fail(options.dryRun ? 'Dry-run failed' : 'Failed to apply schema');
    console.error(chalk.red((error as Error).message));
    process.exit(1);
  }
}
