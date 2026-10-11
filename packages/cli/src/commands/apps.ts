import { text, msg } from '../lib/i18n.js';
import chalk from 'chalk';
import ora from 'ora';
import prompts from 'prompts';
import { initApp, listApps, deleteApp, pauseApp, apiPost, apiDelete, apiPut } from '../lib/api-client.js';
import { setCurrentAppId, getCurrentAppId } from '../lib/config.js';

export async function appsListCommand() {
  const spinner = ora(text('Fetching apps...')).start();

  try {
    const response: any = await listApps();
    spinner.stop();

    if (!response.apps || response.apps.length === 0) {
      console.log(chalk.yellow(text('No apps found')));
      return;
    }

    const currentAppId = await getCurrentAppId();

    console.log(chalk.blue(text('\nYour apps:\n')));
    for (const app of response.apps) {
      const isCurrent = app.id === currentAppId;
      const marker = isCurrent ? chalk.green('→') : ' ';
      console.log(`${marker} ${chalk.bold(app.name)} ${chalk.gray(`(${app.id})`)}`);
      if (isCurrent) {
        console.log(chalk.gray(text(`  Current app`)));
      }
    }
  } catch (error) {
    spinner.fail(text('Failed to fetch apps'));
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
      message: text('App name:'),
      validate: (value) => slugify(value).length > 0 || text('App name is required'),
    });

    if (!response.name) {
      console.log(chalk.yellow(text('Cancelled')));
      process.exit(0);
    }

    name = response.name;
  }

  name = slugify(name);
  const spinner = ora(msg`Creating app "${name}"...`).start();

  try {
    const response: any = await initApp(name);
    spinner.succeed(msg`Created app "${name}"`);

    console.log(chalk.green(text('\n✓ App created successfully!')));
    console.log(chalk.gray(msg`  App ID: ${response.app_id}`));
    console.log(chalk.gray(msg`  API URL: ${response.api_url}`));

    // Ask if they want to set it as current app
    const { setCurrent } = await prompts({
      type: 'confirm',
      name: 'setCurrent',
      message: text('Set as current app?'),
      initial: true,
    });

    if (setCurrent) {
      await setCurrentAppId(response.app_id);
      console.log(chalk.green(text('✓ Set as current app')));
    }
  } catch (error) {
    spinner.fail(text('Failed to create app'));
    console.error(chalk.red((error as Error).message));
    process.exit(1);
  }
}

export async function appsUseCommand(appId: string) {
  if (!appId) {
    console.log(chalk.red(text('✗ App ID is required')));
    console.log(chalk.gray(text('Usage: butterbase apps use <app-id>')));
    process.exit(1);
  }

  await setCurrentAppId(appId);
  console.log(chalk.green(msg`✓ Now using app: ${appId}`));
}

export async function appsPauseCommand(appId: string, options: { reason?: string }) {
  if (!appId) {
    appId = (await getCurrentAppId()) || '';
  }
  if (!appId) {
    console.log(chalk.red(text('✗ App ID is required')));
    console.log(chalk.gray(text('Usage: butterbase apps pause <app-id> [--reason "..."]')));
    process.exit(1);
  }

  const spinner = ora(msg`Pausing ${appId}...`).start();
  try {
    const response: any = await pauseApp(appId, true, options.reason);
    spinner.succeed(msg`Paused ${appId}`);
    console.log(chalk.yellow(text('\n⏸  All data-plane traffic now returns 503 (APP_PAUSED).')));
    if (response.paused_reason) {
      console.log(chalk.gray(msg`   Reason: ${response.paused_reason}`));
    }
    console.log(chalk.gray(msg`   Resume with: butterbase apps resume ${appId}`));
  } catch (error) {
    spinner.fail(text('Failed to pause app'));
    console.error(chalk.red((error as Error).message));
    process.exit(1);
  }
}

export async function appsResumeCommand(appId: string) {
  if (!appId) {
    appId = (await getCurrentAppId()) || '';
  }
  if (!appId) {
    console.log(chalk.red(text('✗ App ID is required')));
    console.log(chalk.gray(text('Usage: butterbase apps resume <app-id>')));
    process.exit(1);
  }

  const spinner = ora(msg`Resuming ${appId}...`).start();
  try {
    await pauseApp(appId, false);
    spinner.succeed(msg`Resumed ${appId}`);
    console.log(chalk.green(text('▶  Data-plane traffic restored.')));
  } catch (error) {
    spinner.fail(text('Failed to resume app'));
    console.error(chalk.red((error as Error).message));
    process.exit(1);
  }
}

export async function appsLinkSubstrateCommand(appId: string) {
  if (!appId) appId = (await getCurrentAppId()) || '';
  if (!appId) {
    console.log(chalk.red(text('✗ App ID is required')));
    console.log(chalk.gray(text('Usage: butterbase apps link-substrate <app-id>')));
    process.exit(1);
  }

  const spinner = ora(msg`Linking ${appId} to substrate...`).start();
  try {
    await apiPost(`/v1/me/apps/${appId}/substrate-link`, {});
    spinner.succeed(msg`Linked ${appId} to substrate`);
    console.log(chalk.gray(text('  Deployed functions now receive ctx.substrate.')));
    console.log(chalk.gray(msg`  Unlink with: butterbase apps unlink-substrate ${appId}`));
  } catch (error) {
    spinner.fail(text('Failed to link app to substrate'));
    console.error(chalk.red((error as Error).message));
    process.exit(1);
  }
}

export async function appsUnlinkSubstrateCommand(appId: string) {
  if (!appId) appId = (await getCurrentAppId()) || '';
  if (!appId) {
    console.log(chalk.red(text('✗ App ID is required')));
    console.log(chalk.gray(text('Usage: butterbase apps unlink-substrate <app-id>')));
    process.exit(1);
  }

  const spinner = ora(msg`Unlinking ${appId} from substrate...`).start();
  try {
    await apiDelete(`/v1/me/apps/${appId}/substrate-link`);
    spinner.succeed(msg`Unlinked ${appId} from substrate`);
  } catch (error) {
    spinner.fail(text('Failed to unlink app from substrate'));
    console.error(chalk.red((error as Error).message));
    process.exit(1);
  }
}

export async function appsSubstrateAutopropagateCommand(appId: string, opts: { users?: boolean }) {
  if (!appId) appId = (await getCurrentAppId()) || '';
  if (!appId) {
    console.log(chalk.red(text('✗ App ID is required')));
    console.log(chalk.gray(text('Usage: butterbase apps substrate-autopropagate <app-id> --users <true|false>')));
    process.exit(1);
  }

  const body: { users?: boolean } = {};
  if (opts.users !== undefined) body.users = opts.users;

  if (Object.keys(body).length === 0) {
    console.log(chalk.red(text('✗ At least one toggle flag must be provided.')));
    console.log(chalk.gray(text('  Example: butterbase apps substrate-autopropagate <app-id> --users true')));
    process.exit(1);
  }

  const spinner = ora(msg`Updating substrate autopropagate settings for ${appId}...`).start();
  try {
    const result: any = await apiPut(`/v1/me/apps/${appId}/substrate-autopropagate`, body);
    spinner.succeed(msg`Updated substrate autopropagate settings for ${appId}`);
    if (result && typeof result === 'object') {
      console.log(chalk.gray(text('\n  Current settings:')));
      for (const [key, value] of Object.entries(result)) {
        console.log(chalk.gray(`    ${key}: ${value}`));
      }
    }
  } catch (error) {
    spinner.fail(text('Failed to update substrate autopropagate settings'));
    console.error(chalk.red((error as Error).message));
    process.exit(1);
  }
}

export async function appsDeleteCommand(appId: string) {
  if (!appId) {
    console.log(chalk.red(text('✗ App ID is required')));
    console.log(chalk.gray(text('Usage: butterbase apps delete <app-id>')));
    process.exit(1);
  }

  const { confirm } = await prompts({
    type: 'confirm',
    name: 'confirm',
    message: msg`Are you sure you want to delete app ${appId}? This cannot be undone.`,
    initial: false,
  });

  if (!confirm) {
    console.log(chalk.yellow(text('Cancelled')));
    return;
  }

  const spinner = ora(text('Deleting app...')).start();

  try {
    await deleteApp(appId);
    spinner.succeed(text('App deleted'));

    // Clear current app if it was deleted
    const currentAppId = await getCurrentAppId();
    if (currentAppId === appId) {
      await setCurrentAppId('');
      console.log(chalk.gray(text('Cleared current app')));
    }
  } catch (error) {
    spinner.fail(text('Failed to delete app'));
    console.error(chalk.red((error as Error).message));
    process.exit(1);
  }
}
