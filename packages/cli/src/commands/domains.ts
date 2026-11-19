import { text, msg } from '../lib/i18n.js';
import chalk from 'chalk';
import ora from 'ora';
import prompts from 'prompts';
import { listCustomDomains, addCustomDomain, getCustomDomainStatus, verifyCustomDomain, deleteCustomDomain } from '../lib/api-client.js';
import { getCurrentAppId } from '../lib/config.js';

async function requireAppId(appId?: string): Promise<string> {
  if (appId) return appId;

  const currentAppId = await getCurrentAppId();
  if (!currentAppId) {
    console.log(chalk.red(text('✗ No app specified and no current app set')));
    console.log(chalk.gray(text('Use: butterbase apps use <app-id>')));
    process.exit(1);
  }

  return currentAppId;
}

export async function domainsListCommand(options: { app?: string }) {
  const appId = await requireAppId(options.app);
  const spinner = ora(text('Fetching custom domains...')).start();

  try {
    const response: any = await listCustomDomains(appId);
    spinner.stop();

    const domains = response.domains || [];
    if (domains.length === 0) {
      console.log(chalk.yellow(text('No custom domains configured')));
      return;
    }

    console.log(chalk.blue(text('\nCustom domains:\n')));
    for (const domain of domains) {
      const statusColor = domain.status === 'active' ? chalk.green : domain.status === 'pending' ? chalk.yellow : chalk.red;
      const sslColor = domain.ssl_status === 'active' ? chalk.green : chalk.yellow;

      console.log(chalk.bold(domain.hostname));
      console.log(chalk.gray(msg`  ID:     ${domain.id}`));
      console.log(msg`  Status: ${statusColor(domain.status)}`);
      console.log(msg`  SSL:    ${sslColor(domain.ssl_status)}`);
      console.log();
    }
  } catch (error) {
    spinner.fail(text('Failed to fetch custom domains'));
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
        chalk.red(msg`✗ --validation-method must be "http" or "txt" (got "${options.validationMethod}")`),
      );
      process.exit(1);
    }
    validationMethod = options.validationMethod;
  }

  const spinner = ora(msg`Adding custom domain "${hostname}"...`).start();

  try {
    const response: any = await addCustomDomain(appId, hostname, validationMethod);
    spinner.succeed(msg`Added custom domain "${hostname}"`);

    const chosenMethod: 'http' | 'txt' = response.validation_method || validationMethod || 'http';

    console.log(chalk.green(text('\n✓ Custom domain registered!')));
    console.log();

    if (chosenMethod === 'txt') {
      console.log(chalk.bold(text('Next steps — add these records at your DNS provider:')));
      console.log();
      console.log(chalk.bold(text('  Routing:')));
      console.log(`    ${chalk.cyan(hostname)}  CNAME  ${chalk.cyan(response.cname_target || 'butterbase.dev')}`);
      console.log(chalk.gray(text('    (apex on Cloudflare: a flattened CNAME at the root is fine)')));
      console.log();

      const txtRecord = (response.verification_records || []).find(
        (r: any) => r.txt_name && r.txt_value,
      );
      console.log(chalk.bold(text('  SSL validation (TXT):')));
      if (txtRecord) {
        console.log(`    ${chalk.cyan(txtRecord.txt_name)}  TXT  ${chalk.cyan(txtRecord.txt_value)}`);
      } else {
        console.log(
          chalk.gray(
            msg`    Pending — run "butterbase domains status ${response.domain?.id}" in ~30s to fetch the TXT details.`,
          ),
        );
      }
      console.log();

      if (response.ownership_verification) {
        const ov = response.ownership_verification;
        console.log(chalk.bold(text('  Ownership (Cloudflare-proxied zones only):')));
        console.log(`    ${chalk.cyan(ov.name)}  ${String(ov.type).toUpperCase()}  ${chalk.cyan(ov.value)}`);
        console.log();
      }
    } else {
      console.log(chalk.bold(text('Next step: Add this CNAME record at your DNS provider:')));
      console.log();
      console.log(`  ${chalk.cyan(hostname)} → ${chalk.cyan(response.cname_target || 'butterbase.dev')}`);
      console.log();
      console.log(
        chalk.gray(
          text('If your DNS is on Cloudflare, use DNS-only (grey cloud).\nFor apex domains on a Cloudflare zone, re-add with --validation-method txt — HTTP DCV cannot work there.'),
        ),
      );
      console.log();
    }

    if (response.instructions) {
      console.log(chalk.gray(response.instructions));
      console.log();
    }
    console.log(chalk.gray(msg`Validation method: ${chosenMethod}`));
    console.log(chalk.gray(msg`Domain ID: ${response.domain?.id}`));
    console.log(chalk.gray(text('Check status with: butterbase domains status <domain-id>')));
  } catch (error) {
    spinner.fail(text('Failed to add custom domain'));
    console.error(chalk.red((error as Error).message));
    process.exit(1);
  }
}

export async function domainsStatusCommand(domainId: string, options: { app?: string }) {
  const appId = await requireAppId(options.app);
  const spinner = ora(text('Checking domain status...')).start();

  try {
    const response: any = await getCustomDomainStatus(appId, domainId);
    spinner.stop();

    const domain = response.domain || response;
    const statusColor = domain.status === 'active' ? chalk.green : domain.status === 'pending' ? chalk.yellow : chalk.red;
    const sslColor = domain.ssl_status === 'active' ? chalk.green : chalk.yellow;

    console.log(chalk.blue(text('\nDomain status:\n')));
    console.log(msg`  Hostname: ${chalk.bold(domain.hostname)}`);
    console.log(msg`  Status:   ${statusColor(domain.status)}`);
    console.log(msg`  SSL:      ${sslColor(domain.ssl_status)}`);

    if (response.verification) {
      if (response.verification.type) {
        console.log(msg`  Verification: ${response.verification.type}`);
      }
      if (response.verification.errors && response.verification.errors.length > 0) {
        console.log(msg`  Errors: ${chalk.red(JSON.stringify(response.verification.errors))}`);
      }
    }

    if (response.instructions) {
      console.log();
      console.log(chalk.gray(response.instructions));
    }
  } catch (error) {
    spinner.fail(text('Failed to check domain status'));
    console.error(chalk.red((error as Error).message));
    process.exit(1);
  }
}

export async function domainsVerifyCommand(domainId: string, options: { app?: string }) {
  const appId = await requireAppId(options.app);
  const spinner = ora(text('Re-verifying domain...')).start();

  try {
    const response: any = await verifyCustomDomain(appId, domainId);
    spinner.succeed(text('Verification triggered'));

    const domain = response.domain || response;
    const statusColor = domain.status === 'active' ? chalk.green : chalk.yellow;

    console.log(msg`  Status: ${statusColor(domain.status)}`);
    console.log(msg`  SSL:    ${domain.ssl_status === 'active' ? chalk.green(domain.ssl_status) : chalk.yellow(domain.ssl_status)}`);
  } catch (error) {
    spinner.fail(text('Failed to re-verify domain'));
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
      message: msg`Are you sure you want to remove custom domain ${domainId}?`,
      initial: false,
    });

    if (!confirm) {
      console.log(chalk.yellow(text('Cancelled')));
      return;
    }
  }

  const spinner = ora(text('Removing custom domain...')).start();

  try {
    await deleteCustomDomain(appId, domainId);
    spinner.succeed(text('Custom domain removed'));
    console.log(chalk.green(text('\n✓ Custom domain removed successfully!')));
  } catch (error) {
    spinner.fail(text('Failed to remove custom domain'));
    console.error(chalk.red((error as Error).message));
    process.exit(1);
  }
}
