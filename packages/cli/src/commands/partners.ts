import chalk from 'chalk';
import ora from 'ora';
import { spawnSync } from 'node:child_process';
import { listPartners } from '../lib/api-client.js';
import { getCurrentAppId, getApiKey, getApiUrl } from '../lib/config.js';

async function requireAppId(appId?: string): Promise<string> {
  if (appId) return appId;
  const current = await getCurrentAppId();
  if (!current) {
    console.log(chalk.red('✗ No app specified and no current app set'));
    console.log(chalk.gray('Use: butterbase apps use <app-id>'));
    process.exit(1);
  }
  return current;
}

export async function partnersListCommand(options: { app?: string; hackathon: string }) {
  const appId = await requireAppId(options.app);
  const spinner = ora('Fetching partners...').start();
  try {
    const { partners } = await listPartners(appId, options.hackathon);
    spinner.stop();
    if (!partners.length) {
      console.log(chalk.yellow('No partner APIs available.'));
      console.log(chalk.gray(`Either no partners are configured for "${options.hackathon}", or you are not a participant.`));
      return;
    }
    console.log(chalk.blue(`\nPartner APIs (${partners.length}):\n`));
    for (const p of partners) {
      const status = p.status === 'available'
        ? chalk.green('available')
        : chalk.red('exhausted');
      console.log(`  ${chalk.bold(p.slug.padEnd(15))} ${p.display_name}  [${status}]`);
      if (p.description) console.log(`    ${chalk.gray(p.description)}`);
      if (p.docs_url) console.log(`    ${chalk.gray(p.docs_url)}`);
      if (p.status === 'exhausted') {
        console.log(`    ${chalk.yellow(p.contact_message)}`);
      }
    }
    console.log();
  } catch (error) {
    spinner.fail('Failed to fetch partners');
    console.error(chalk.red((error as Error).message));
    process.exit(1);
  }
}

export async function partnersCurlCommand(
  slug: string, path: string, options: { app?: string; hackathon: string; execute?: boolean; method?: string; data?: string },
) {
  const appId = await requireAppId(options.app);
  const apiUrl = await getApiUrl();
  const apiKey = await getApiKey();
  if (!apiKey) {
    console.log(chalk.red('✗ Not logged in'));
    console.log(chalk.gray('Run: butterbase login'));
    process.exit(1);
  }
  if (!path.startsWith('/')) {
    console.log(chalk.red(`✗ Path must start with "/" (got "${path}")`));
    process.exit(1);
  }

  const url = `${apiUrl}/v1/${appId}/partners/${encodeURIComponent(options.hackathon)}/${slug}${path}`;
  const method = (options.method ?? 'GET').toUpperCase();
  const args = ['-X', method, '-H', `Authorization: Bearer ${apiKey}`];
  if (options.data) {
    args.push('-H', 'Content-Type: application/json', '--data', options.data);
  }
  args.push(url);

  if (options.execute) {
    spawnSync('curl', args, { stdio: 'inherit' });
    return;
  }

  const masked = `${apiKey.slice(0, 9)}…${apiKey.slice(-4)}`;
  const printArgs = args.map((a) => a.includes(apiKey) ? a.replace(apiKey, masked) : a);
  console.log('curl ' + printArgs.map((a) => /\s/.test(a) ? `'${a}'` : a).join(' '));
  console.log(chalk.gray('\n# Re-run with --execute (-x) to send for real, or replace masked key.'));
}
