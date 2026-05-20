import chalk from 'chalk';
import ora from 'ora';
import prompts from 'prompts';
import { listCustomDomains, addCustomDomain, getCustomDomainStatus, verifyCustomDomain, deleteCustomDomain } from '../lib/api-client.js';
import { getCurrentAppId } from '../lib/config.js';

async function requireAppId(appId?: string): Promise<string> {
  if (appId) return appId;

  const currentAppId = await getCurrentAppId();
  if (!currentAppId) {
    console.log(chalk.red('✗ No app specified and no current app set'));
    console.log(chalk.gray('Use: butterbase apps use <app-id>'));
    process.exit(1);
  }

  return currentAppId;
}

export async function domainsListCommand(options: { app?: string }) {
  const appId = await requireAppId(options.app);
  const spinner = ora('Fetching custom domains...').start();

  try {
    const response: any = await listCustomDomains(appId);
    spinner.stop();

    const domains = response.domains || [];
    if (domains.length === 0) {
      console.log(chalk.yellow('No custom domains configured'));
      return;
    }

    console.log(chalk.blue('\nCustom domains:\n'));
    for (const domain of domains) {
      const statusColor = domain.status === 'active' ? chalk.green : domain.status === 'pending' ? chalk.yellow : chalk.red;
      const sslColor = domain.ssl_status === 'active' ? chalk.green : chalk.yellow;

      console.log(chalk.bold(domain.hostname));
      console.log(chalk.gray(`  ID:     ${domain.id}`));
      console.log(`  Status: ${statusColor(domain.status)}`);
      console.log(`  SSL:    ${sslColor(domain.ssl_status)}`);
      console.log();
    }
  } catch (error) {
    spinner.fail('Failed to fetch custom domains');
    console.error(chalk.red((error as Error).message));
    process.exit(1);
  }
}

export async function domainsAddCommand(hostname: string, options: { app?: string }) {
  const appId = await requireAppId(options.app);
  const spinner = ora(`Adding custom domain "${hostname}"...`).start();

  try {
    const response: any = await addCustomDomain(appId, hostname);
    spinner.succeed(`Added custom domain "${hostname}"`);

    console.log(chalk.green('\n✓ Custom domain registered!'));
    console.log();
    console.log(chalk.bold('Next step: Add this CNAME record at your DNS provider:'));
    console.log();
    console.log(`  ${chalk.cyan(hostname)} → ${chalk.cyan(response.cname_target || 'butterbase.dev')}`);
    console.log();
    if (response.instructions) {
      console.log(chalk.gray(response.instructions));
    }
    console.log(chalk.gray(`Domain ID: ${response.domain?.id}`));
    console.log(chalk.gray('Check status with: butterbase domains status <domain-id>'));
  } catch (error) {
    spinner.fail('Failed to add custom domain');
    console.error(chalk.red((error as Error).message));
    process.exit(1);
  }
}

export async function domainsStatusCommand(domainId: string, options: { app?: string }) {
  const appId = await requireAppId(options.app);
  const spinner = ora('Checking domain status...').start();

  try {
    const response: any = await getCustomDomainStatus(appId, domainId);
    spinner.stop();

    const domain = response.domain || response;
    const statusColor = domain.status === 'active' ? chalk.green : domain.status === 'pending' ? chalk.yellow : chalk.red;
    const sslColor = domain.ssl_status === 'active' ? chalk.green : chalk.yellow;

    console.log(chalk.blue('\nDomain status:\n'));
    console.log(`  Hostname: ${chalk.bold(domain.hostname)}`);
    console.log(`  Status:   ${statusColor(domain.status)}`);
    console.log(`  SSL:      ${sslColor(domain.ssl_status)}`);

    if (response.verification) {
      if (response.verification.type) {
        console.log(`  Verification: ${response.verification.type}`);
      }
      if (response.verification.errors && response.verification.errors.length > 0) {
        console.log(`  Errors: ${chalk.red(JSON.stringify(response.verification.errors))}`);
      }
    }

    if (response.instructions) {
      console.log();
      console.log(chalk.gray(response.instructions));
    }
  } catch (error) {
    spinner.fail('Failed to check domain status');
    console.error(chalk.red((error as Error).message));
    process.exit(1);
  }
}

export async function domainsVerifyCommand(domainId: string, options: { app?: string }) {
  const appId = await requireAppId(options.app);
  const spinner = ora('Re-verifying domain...').start();

  try {
    const response: any = await verifyCustomDomain(appId, domainId);
    spinner.succeed('Verification triggered');

    const domain = response.domain || response;
    const statusColor = domain.status === 'active' ? chalk.green : chalk.yellow;

    console.log(`  Status: ${statusColor(domain.status)}`);
    console.log(`  SSL:    ${domain.ssl_status === 'active' ? chalk.green(domain.ssl_status) : chalk.yellow(domain.ssl_status)}`);
  } catch (error) {
    spinner.fail('Failed to re-verify domain');
    console.error(chalk.red((error as Error).message));
    process.exit(1);
  }
}

export async function domainsDeleteCommand(domainId: string, options: { app?: string; yes?: boolean }) {
  const appId = await requireAppId(options.app);

  if (!options.yes) {
    const { confirm } = await prompts({
      type: 'confirm',
      name: 'confirm',
      message: `Are you sure you want to remove custom domain ${domainId}?`,
      initial: false,
    });

    if (!confirm) {
      console.log(chalk.yellow('Cancelled'));
      return;
    }
  }

  const spinner = ora('Removing custom domain...').start();

  try {
    await deleteCustomDomain(appId, domainId);
    spinner.succeed('Custom domain removed');
    console.log(chalk.green('\n✓ Custom domain removed successfully!'));
  } catch (error) {
    spinner.fail('Failed to remove custom domain');
    console.error(chalk.red((error as Error).message));
    process.exit(1);
  }
}
