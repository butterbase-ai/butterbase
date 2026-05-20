import chalk from 'chalk';
import ora from 'ora';
import { oauthCreate, oauthList, oauthGet, oauthUpdate, oauthDelete } from '../lib/api-client.js';
import { getCurrentAppId } from '../lib/config.js';

async function requireAppId(appId?: string): Promise<string> {
  if (appId) return appId;
  const current = await getCurrentAppId();
  if (!current) {
    console.log(chalk.red('No app specified and no current app set'));
    console.log(chalk.gray('Use: butterbase apps use <app-id>'));
    process.exit(1);
  }
  return current;
}

export async function oauthConfigureCommand(
  provider: string,
  options: {
    app?: string; clientId: string; clientSecret: string;
    redirectUri?: string[]; scope?: string[];
    authorizationUrl?: string; tokenUrl?: string; userinfoUrl?: string;
    json?: boolean;
  },
) {
  const appId = await requireAppId(options.app);
  const body: Record<string, unknown> = {
    provider,
    client_id: options.clientId,
    client_secret: options.clientSecret,
  };
  if (options.redirectUri) body.redirect_uris = options.redirectUri;
  if (options.scope) body.scopes = options.scope;
  if (options.authorizationUrl) body.authorization_url = options.authorizationUrl;
  if (options.tokenUrl) body.token_url = options.tokenUrl;
  if (options.userinfoUrl) body.userinfo_url = options.userinfoUrl;
  const spinner = ora(`Configuring OAuth provider: ${provider}`).start();
  try {
    const r = await oauthCreate(appId, body);
    spinner.succeed(`Configured ${provider}`);
    if (options.json) console.log(JSON.stringify(r, null, 2));
  } catch (e) {
    spinner.fail('Configure failed');
    console.error(chalk.red((e as Error).message));
    process.exit(1);
  }
}

export async function oauthListCommand(options: { app?: string; json?: boolean }) {
  const appId = await requireAppId(options.app);
  try {
    const r: any = await oauthList(appId);
    if (options.json) return console.log(JSON.stringify(r, null, 2));
    const providers = r.providers ?? r;
    if (!Array.isArray(providers) || providers.length === 0) {
      console.log(chalk.gray('No OAuth providers configured.'));
      return;
    }
    for (const p of providers) {
      console.log(`${p.provider}  enabled=${p.enabled}`);
    }
  } catch (e) {
    console.error(chalk.red((e as Error).message));
    process.exit(1);
  }
}

export async function oauthGetCommand(provider: string, options: { app?: string; json?: boolean }) {
  const appId = await requireAppId(options.app);
  try {
    const r = await oauthGet(appId, provider);
    console.log(options.json ? JSON.stringify(r, null, 2) : r);
  } catch (e) {
    console.error(chalk.red((e as Error).message));
    process.exit(1);
  }
}

export async function oauthUpdateCommand(
  provider: string,
  options: {
    app?: string; clientId?: string; clientSecret?: string;
    redirectUri?: string[]; scope?: string[]; enabled?: boolean;
    json?: boolean;
  },
) {
  const appId = await requireAppId(options.app);
  const body: Record<string, unknown> = {};
  if (options.clientId) body.client_id = options.clientId;
  if (options.clientSecret) body.client_secret = options.clientSecret;
  if (options.redirectUri) body.redirect_uris = options.redirectUri;
  if (options.scope) body.scopes = options.scope;
  if (options.enabled !== undefined) body.enabled = options.enabled;
  if (Object.keys(body).length === 0) {
    console.log(chalk.yellow('Nothing to update — pass at least one field.'));
    process.exit(1);
  }
  const spinner = ora(`Updating ${provider}...`).start();
  try {
    const r = await oauthUpdate(appId, provider, body);
    spinner.succeed(`Updated ${provider}`);
    if (options.json) console.log(JSON.stringify(r, null, 2));
  } catch (e) {
    spinner.fail('Update failed');
    console.error(chalk.red((e as Error).message));
    process.exit(1);
  }
}

export async function oauthDeleteCommand(provider: string, options: { app?: string; json?: boolean }) {
  const appId = await requireAppId(options.app);
  const spinner = ora(`Deleting ${provider}...`).start();
  try {
    await oauthDelete(appId, provider);
    spinner.succeed(`Deleted ${provider}`);
    if (options.json) console.log(JSON.stringify({ deleted: true }));
  } catch (e) {
    spinner.fail('Delete failed');
    console.error(chalk.red((e as Error).message));
    process.exit(1);
  }
}
