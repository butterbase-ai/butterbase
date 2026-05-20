import chalk from 'chalk';
import ora from 'ora';
import prompts from 'prompts';
import { initApp, listApps, deleteApp, pauseApp } from '../lib/api-client.js';
import { setCurrentAppId, getCurrentAppId } from '../lib/config.js';

export async function appsListCommand() {
  const spinner = ora('Fetching apps...').start();

  try {
    const response: any = await listApps();
    spinner.stop();

    if (!response.apps || response.apps.length === 0) {
      console.log(chalk.yellow('No apps found'));
      return;
    }

    const currentAppId = await getCurrentAppId();

    console.log(chalk.blue('\nYour apps:\n'));
    for (const app of response.apps) {
      const isCurrent = app.id === currentAppId;
      const marker = isCurrent ? chalk.green('→') : ' ';
      console.log(`${marker} ${chalk.bold(app.name)} ${chalk.gray(`(${app.id})`)}`);
      if (isCurrent) {
        console.log(chalk.gray(`  Current app`));
      }
    }
  } catch (error) {
    spinner.fail('Failed to fetch apps');
    console.error(chalk.red((error as Error).message));
    process.exit(1);
  }
}

function slugify(v: string): string {
  return v.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '').replace(/^[^a-z0-9]+/, '').slice(0, 63);
}

export async function appsCreateCommand(name: string) {
  if (!name) {
    const response = await prompts({
      type: 'text',
      name: 'name',
      message: 'App name:',
      validate: (value) => slugify(value).length > 0 || 'App name is required',
    });

    if (!response.name) {
      console.log(chalk.yellow('Cancelled'));
      process.exit(0);
    }

    name = response.name;
  }

  name = slugify(name);
  const spinner = ora(`Creating app "${name}"...`).start();

  try {
    const response: any = await initApp(name);
    spinner.succeed(`Created app "${name}"`);

    console.log(chalk.green('\n✓ App created successfully!'));
    console.log(chalk.gray(`  App ID: ${response.app_id}`));
    console.log(chalk.gray(`  API URL: ${response.api_url}`));

    // Ask if they want to set it as current app
    const { setCurrent } = await prompts({
      type: 'confirm',
      name: 'setCurrent',
      message: 'Set as current app?',
      initial: true,
    });

    if (setCurrent) {
      await setCurrentAppId(response.app_id);
      console.log(chalk.green('✓ Set as current app'));
    }
  } catch (error) {
    spinner.fail('Failed to create app');
    console.error(chalk.red((error as Error).message));
    process.exit(1);
  }
}

export async function appsUseCommand(appId: string) {
  if (!appId) {
    console.log(chalk.red('✗ App ID is required'));
    console.log(chalk.gray('Usage: butterbase apps use <app-id>'));
    process.exit(1);
  }

  await setCurrentAppId(appId);
  console.log(chalk.green(`✓ Now using app: ${appId}`));
}

export async function appsPauseCommand(appId: string, options: { reason?: string }) {
  if (!appId) {
    appId = (await getCurrentAppId()) || '';
  }
  if (!appId) {
    console.log(chalk.red('✗ App ID is required'));
    console.log(chalk.gray('Usage: butterbase apps pause <app-id> [--reason "..."]'));
    process.exit(1);
  }

  const spinner = ora(`Pausing ${appId}...`).start();
  try {
    const response: any = await pauseApp(appId, true, options.reason);
    spinner.succeed(`Paused ${appId}`);
    console.log(chalk.yellow('\n⏸  All data-plane traffic now returns 503 (APP_PAUSED).'));
    if (response.paused_reason) {
      console.log(chalk.gray(`   Reason: ${response.paused_reason}`));
    }
    console.log(chalk.gray(`   Resume with: butterbase apps resume ${appId}`));
  } catch (error) {
    spinner.fail('Failed to pause app');
    console.error(chalk.red((error as Error).message));
    process.exit(1);
  }
}

export async function appsResumeCommand(appId: string) {
  if (!appId) {
    appId = (await getCurrentAppId()) || '';
  }
  if (!appId) {
    console.log(chalk.red('✗ App ID is required'));
    console.log(chalk.gray('Usage: butterbase apps resume <app-id>'));
    process.exit(1);
  }

  const spinner = ora(`Resuming ${appId}...`).start();
  try {
    await pauseApp(appId, false);
    spinner.succeed(`Resumed ${appId}`);
    console.log(chalk.green('▶  Data-plane traffic restored.'));
  } catch (error) {
    spinner.fail('Failed to resume app');
    console.error(chalk.red((error as Error).message));
    process.exit(1);
  }
}

export async function appsDeleteCommand(appId: string) {
  if (!appId) {
    console.log(chalk.red('✗ App ID is required'));
    console.log(chalk.gray('Usage: butterbase apps delete <app-id>'));
    process.exit(1);
  }

  const { confirm } = await prompts({
    type: 'confirm',
    name: 'confirm',
    message: `Are you sure you want to delete app ${appId}? This cannot be undone.`,
    initial: false,
  });

  if (!confirm) {
    console.log(chalk.yellow('Cancelled'));
    return;
  }

  const spinner = ora('Deleting app...').start();

  try {
    await deleteApp(appId);
    spinner.succeed('App deleted');

    // Clear current app if it was deleted
    const currentAppId = await getCurrentAppId();
    if (currentAppId === appId) {
      await setCurrentAppId('');
      console.log(chalk.gray('Cleared current app'));
    }
  } catch (error) {
    spinner.fail('Failed to delete app');
    console.error(chalk.red((error as Error).message));
    process.exit(1);
  }
}
