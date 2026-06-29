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

export async function domainsAddCommand(
  hostname: string,
  options: { app?: string; validationMethod?: string },
) {
  const appId = await requireAppId(options.app);

  let validationMethod: 'http' | 'txt' | undefined;
  if (options.validationMethod !== undefined) {
    if (options.validationMethod !== 'http' && options.validationMethod !== 'txt') {
      console.error(
        chalk.red(`✗ --validation-method must be "http" or "txt" (got "${options.validationMethod}")`),
      );
      process.exit(1);
    }
    validationMethod = options.validationMethod;
  }

  const spinner = ora(`Adding custom domain "${hostname}"...`).start();

  try {
    const response: any = await addCustomDomain(appId, hostname, validationMethod);
    spinner.succeed(`Added custom domain "${hostname}"`);

    const chosenMethod: 'http' | 'txt' = response.validation_method || validationMethod || 'http';

    console.log(chalk.green('\n✓ Custom domain registered!'));
    console.log();

    if (chosenMethod === 'txt') {
      console.log(chalk.bold('Next steps — add these records at your DNS provider:'));
      console.log();
      console.log(chalk.bold('  Routing:'));
      console.log(`    ${chalk.cyan(hostname)}  CNAME  ${chalk.cyan(response.cname_target || 'butterbase.dev')}`);
      console.log(chalk.gray('    (apex on Cloudflare: a flattened CNAME at the root is fine)'));
      console.log();

      const txtRecord = (response.verification_records || []).find(
        (r: any) => r.txt_name && r.txt_value,
      );
      console.log(chalk.bold('  SSL validation (TXT):'));
      if (txtRecord) {
        console.log(`    ${chalk.cyan(txtRecord.txt_name)}  TXT  ${chalk.cyan(txtRecord.txt_value)}`);
      } else {
        console.log(
          chalk.gray(
            `    Pending — run "butterbase domains status ${response.domain?.id}" in ~30s to fetch the TXT details.`,
          ),
        );
      }
      console.log();

      if (response.ownership_verification) {
        const ov = response.ownership_verification;
        console.log(chalk.bold('  Ownership (Cloudflare-proxied zones only):'));
        console.log(`    ${chalk.cyan(ov.name)}  ${String(ov.type).toUpperCase()}  ${chalk.cyan(ov.value)}`);
        console.log();
      }
    } else {
      console.log(chalk.bold('Next step: Add this CNAME record at your DNS provider:'));
      console.log();
      console.log(`  ${chalk.cyan(hostname)} → ${chalk.cyan(response.cname_target || 'butterbase.dev')}`);
      console.log();
      console.log(
        chalk.gray(
          'If your DNS is on Cloudflare, use DNS-only (grey cloud).\nFor apex domains on a Cloudflare zone, re-add with --validation-method txt — HTTP DCV cannot work there.',
        ),
      );
      console.log();
    }

    if (response.instructions) {
      console.log(chalk.gray(response.instructions));
      console.log();
    }
    console.log(chalk.gray(`Validation method: ${chosenMethod}`));
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
