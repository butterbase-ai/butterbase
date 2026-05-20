import prompts from 'prompts';
import chalk from 'chalk';
import { updateConfig, loadConfig } from '../lib/config.js';

export async function loginCommand() {
  console.log(chalk.blue('🔐 Butterbase Login\n'));

  const { apiKey } = await prompts({
    type: 'password',
    name: 'apiKey',
    message: 'Enter your Butterbase API key:',
    validate: (value) => value.length > 0 || 'API key is required',
  });

  if (!apiKey) {
    console.log(chalk.yellow('Login cancelled'));
    process.exit(0);
  }

  await updateConfig('apiKey', apiKey);

  console.log(chalk.green('✓ Successfully logged in!'));
  console.log(chalk.gray(`Config saved to ~/.butterbase/config.json`));
}

export async function logoutCommand() {
  await updateConfig('apiKey', undefined);
  console.log(chalk.green('✓ Successfully logged out'));
}

export async function configGetCommand() {
  const config = await loadConfig();
  console.log(chalk.blue('Current configuration:\n'));
  console.log(JSON.stringify(config, null, 2));
}

export async function configSetCommand(key: string, value: string) {
  const config = await loadConfig();

  // Type-safe config update
  if (key in config) {
    (config as any)[key] = value;
    await updateConfig(key as any, value);
    console.log(chalk.green(`✓ Set ${key} = ${value}`));
  } else {
    console.log(chalk.red(`✗ Unknown config key: ${key}`));
    console.log(chalk.gray('Valid keys: endpoint, apiKey, currentApp'));
    process.exit(1);
  }
}
