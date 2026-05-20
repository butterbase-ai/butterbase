import chalk from 'chalk';
import ora from 'ora';
import prompts from 'prompts';
import { generateApiKey, listApiKeys, revokeApiKey } from '../lib/api-client.js';

export async function keysGenerateCommand(name: string | undefined, options: { scope?: string[]; json?: boolean }) {
  if (!name) {
    const { keyName } = await prompts({
      type: 'text',
      name: 'keyName',
      message: 'Key name:',
      validate: (v) => v.length > 0 || 'Name is required',
    });
    if (!keyName) { console.log(chalk.yellow('Cancelled')); process.exit(0); }
    name = keyName;
  }

  const spinner = ora('Generating API key...').start();

  try {
    const result = await generateApiKey(name!, options.scope);
    spinner.succeed('API key generated');

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log('');
    console.log(`  Key:    ${chalk.green(result.key)}`);
    console.log(`  Name:   ${result.name}`);
    console.log(`  Key ID: ${chalk.gray(result.keyId)}`);
    console.log('');
    console.log(chalk.yellow('  Store this key securely — it will not be shown again.'));
  } catch (error) {
    spinner.fail('Failed to generate API key');
    console.error(chalk.red((error as Error).message));
    process.exit(1);
  }
}

export async function keysListCommand(options: { json?: boolean }) {
  const spinner = ora('Fetching API keys...').start();

  try {
    const result = await listApiKeys();
    spinner.stop();

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    const keys = (result as any).keys || [];
    if (keys.length === 0) {
      console.log(chalk.yellow('No API keys found'));
      return;
    }

    for (const key of keys) {
      console.log(`  ${chalk.white(key.name || 'unnamed')}  ${chalk.gray((key.key_prefix ?? key.prefix) + '...')}  ${chalk.gray(key.created_at?.slice(0, 10) || '')}`);
    }
    console.log(chalk.gray(`\n(${keys.length} key${keys.length === 1 ? '' : 's'})`));
  } catch (error) {
    spinner.fail('Failed to list API keys');
    console.error(chalk.red((error as Error).message));
    process.exit(1);
  }
}

export async function keysRevokeCommand(keyId: string) {
  const { confirm } = await prompts({
    type: 'confirm',
    name: 'confirm',
    message: `Revoke key ${keyId}?`,
    initial: false,
  });

  if (!confirm) { console.log(chalk.yellow('Cancelled')); return; }

  const spinner = ora('Revoking API key...').start();

  try {
    await revokeApiKey(keyId);
    spinner.succeed('API key revoked');
  } catch (error) {
    spinner.fail('Failed to revoke API key');
    console.error(chalk.red((error as Error).message));
    process.exit(1);
  }
}
