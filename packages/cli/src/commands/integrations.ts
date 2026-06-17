import chalk from 'chalk';
import ora from 'ora';
import {
  getAvailableIntegrations,
  getIntegrationConfig,
  configureIntegration,
  rotateIntegrationCredentials,
  disableIntegration,
  connectIntegration,
  listConnections,
  disconnectAccount,
  listIntegrationTools,
  executeIntegrationTool,
  type OAuthCredentialsInput,
} from '../lib/api-client.js';
import { getCurrentAppId } from '../lib/config.js';

/**
 * Resolve BYO OAuth credentials from CLI flags, falling back to env vars.
 *
 * Env-var convention mirrors how function deploys pull secrets: the toolkit
 * slug is uppercased and hyphens become underscores, then suffixed with
 * `_CLIENT_ID` / `_CLIENT_SECRET`. Examples:
 *   twitter         → TWITTER_CLIENT_ID, TWITTER_CLIENT_SECRET
 *   google-calendar → GOOGLE_CALENDAR_CLIENT_ID, GOOGLE_CALENDAR_CLIENT_SECRET
 *
 * Returns undefined when neither flag nor env supplies a client_id (so the
 * caller can fall through to Composio-managed auth for curated toolkits).
 * Throws when one half is provided and the other isn't — that's almost
 * always a typo, not an intent to half-configure.
 */
function resolveOAuthCredentials(
  toolkit: string,
  opts: { clientId?: string; clientSecret?: string; authScheme?: string },
  options: { requireBoth?: boolean } = {},
): OAuthCredentialsInput | undefined {
  const envBase = toolkit.toUpperCase().replace(/-/g, '_');
  const clientId = opts.clientId ?? process.env[`${envBase}_CLIENT_ID`];
  const clientSecret = opts.clientSecret ?? process.env[`${envBase}_CLIENT_SECRET`];
  if (!clientId && !clientSecret) return options.requireBoth ? (() => {
    throw new Error(
      `Missing OAuth credentials. Pass --client-id and --client-secret, ` +
      `or export ${envBase}_CLIENT_ID and ${envBase}_CLIENT_SECRET.`,
    );
  })() : undefined;
  if (!clientId || !clientSecret) {
    throw new Error(
      `Incomplete OAuth credentials. Provide BOTH client_id and client_secret ` +
      `(via --client-id/--client-secret or ${envBase}_CLIENT_ID/${envBase}_CLIENT_SECRET).`,
    );
  }
  return { client_id: clientId, client_secret: clientSecret, auth_scheme: opts.authScheme };
}

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

export async function integrationsListCommand(options: { app?: string; search?: string }) {
  const appId = await requireAppId(options.app);
  const spinner = ora('Fetching integrations...').start();
  try {
    const response = await getAvailableIntegrations(appId, options.search);
    spinner.stop();
    const integrations = response.integrations ?? [];
    if (integrations.length === 0) {
      console.log(chalk.yellow('No integrations found'));
      return;
    }
    console.log(chalk.blue(`\nAvailable integrations (${integrations.length}):\n`));
    for (const i of integrations) {
      const curatedTag = i.curated ? chalk.green(' [curated]') : '';
      console.log(`  ${chalk.bold(i.toolkit)}${curatedTag}`);
    }
  } catch (error) {
    spinner.fail('Failed to fetch integrations');
    console.error(chalk.red((error as Error).message));
    process.exit(1);
  }
}

export async function integrationsConfigCommand(options: { app?: string }) {
  const appId = await requireAppId(options.app);
  const spinner = ora('Fetching integration config...').start();
  try {
    const response = await getIntegrationConfig(appId);
    spinner.stop();
    const configs = response.integrations ?? [];
    if (configs.length === 0) {
      console.log(chalk.yellow('No integrations configured'));
      console.log(chalk.gray(`Enable one: butterbase integrations configure <toolkit> --app ${appId}`));
      return;
    }
    console.log(chalk.blue(`\nConfigured integrations:\n`));
    for (const c of configs) {
      console.log(chalk.bold(`  ${c.toolkit_slug}`));
      if (c.display_name) console.log(chalk.gray(`    Name: ${c.display_name}`));
      console.log();
    }
  } catch (error) {
    spinner.fail('Failed to fetch integration config');
    console.error(chalk.red((error as Error).message));
    process.exit(1);
  }
}

export async function integrationsConfigureCommand(
  toolkit: string,
  options: {
    app?: string;
    displayName?: string;
    scope?: string[];
    clientId?: string;
    clientSecret?: string;
    authScheme?: string;
  },
) {
  const appId = await requireAppId(options.app);
  let creds: OAuthCredentialsInput | undefined;
  try {
    creds = resolveOAuthCredentials(toolkit, options);
  } catch (error) {
    console.error(chalk.red(`✗ ${(error as Error).message}`));
    process.exit(1);
  }
  const spinner = ora(`Configuring ${toolkit}${creds ? ' (BYO credentials)' : ''}...`).start();
  try {
    await configureIntegration(appId, toolkit, options.displayName, options.scope, creds);
    spinner.succeed(`${toolkit} configured`);
  } catch (error) {
    spinner.fail(`Failed to configure ${toolkit}`);
    console.error(chalk.red((error as Error).message));
    process.exit(1);
  }
}

export async function integrationsRotateCommand(
  toolkit: string,
  options: { app?: string; clientId?: string; clientSecret?: string; authScheme?: string },
) {
  const appId = await requireAppId(options.app);
  let creds: OAuthCredentialsInput;
  try {
    creds = resolveOAuthCredentials(toolkit, options, { requireBoth: true })!;
  } catch (error) {
    console.error(chalk.red(`✗ ${(error as Error).message}`));
    process.exit(1);
    return;
  }
  const spinner = ora(`Rotating credentials for ${toolkit}...`).start();
  try {
    await rotateIntegrationCredentials(appId, toolkit, creds);
    spinner.succeed(`${toolkit} credentials rotated`);
  } catch (error) {
    spinner.fail(`Failed to rotate ${toolkit} credentials`);
    console.error(chalk.red((error as Error).message));
    process.exit(1);
  }
}

export async function integrationsDisableCommand(toolkit: string, options: { app?: string }) {
  const appId = await requireAppId(options.app);
  const spinner = ora(`Disabling ${toolkit}...`).start();
  try {
    await disableIntegration(appId, toolkit);
    spinner.succeed(`${toolkit} disabled`);
  } catch (error) {
    spinner.fail(`Failed to disable ${toolkit}`);
    console.error(chalk.red((error as Error).message));
    process.exit(1);
  }
}

export async function integrationsConnectCommand(toolkit: string, options: { app?: string; redirectUrl?: string; userId?: string; scope?: string[] }) {
  const appId = await requireAppId(options.app);
  const redirectUrl = options.redirectUrl || 'https://butterbase.ai';
  const spinner = ora(`Generating OAuth URL for ${toolkit}...`).start();
  try {
    const response = await connectIntegration(appId, toolkit, redirectUrl, options.userId, options.scope);
    spinner.stop();
    console.log(chalk.green('\n✓ OAuth URL generated'));
    console.log(chalk.bold('\nSend the user to this URL:\n'));
    console.log(`  ${response.authUrl}\n`);
    console.log(chalk.gray(`Connection request ID: ${response.connectionRequestId}`));
  } catch (error) {
    spinner.fail('Failed to generate connect URL');
    console.error(chalk.red((error as Error).message));
    process.exit(1);
  }
}

export async function integrationsConnectionsCommand(options: { app?: string }) {
  const appId = await requireAppId(options.app);
  const spinner = ora('Fetching connections...').start();
  try {
    const response = await listConnections(appId);
    spinner.stop();
    const connections = response.connections ?? [];
    if (connections.length === 0) {
      console.log(chalk.yellow('No connected accounts'));
      return;
    }
    console.log(chalk.blue(`\nConnected accounts (${connections.length}):\n`));
    for (const c of connections) {
      console.log(chalk.bold(`  ${c.toolkit_slug}`));
      console.log(chalk.gray(`    ID: ${c.id}`));
      console.log(chalk.gray(`    User: ${c.app_user_id}`));
      console.log(chalk.gray(`    Status: ${c.status}`));
      console.log(chalk.gray(`    Connected: ${new Date(c.connected_at).toLocaleDateString()}`));
      console.log();
    }
  } catch (error) {
    spinner.fail('Failed to fetch connections');
    console.error(chalk.red((error as Error).message));
    process.exit(1);
  }
}

export async function integrationsDisconnectCommand(connectionId: string, options: { app?: string }) {
  const appId = await requireAppId(options.app);
  const spinner = ora('Disconnecting account...').start();
  try {
    await disconnectAccount(appId, connectionId);
    spinner.succeed('Account disconnected');
  } catch (error) {
    spinner.fail('Failed to disconnect account');
    console.error(chalk.red((error as Error).message));
    process.exit(1);
  }
}

export async function integrationsToolsCommand(toolkit: string | undefined, options: { app?: string }) {
  const appId = await requireAppId(options.app);
  const spinner = ora('Fetching tools...').start();
  try {
    const response = await listIntegrationTools(appId, toolkit);
    spinner.stop();
    const tools = response.tools ?? [];
    if (tools.length === 0) {
      console.log(chalk.yellow('No tools found'));
      return;
    }
    const label = toolkit ? `${toolkit} tools` : 'Available tools';
    console.log(chalk.blue(`\n${label} (${tools.length}):\n`));
    for (const t of tools) {
      console.log(`  ${chalk.bold(t.name)}`);
      if (t.description) console.log(chalk.gray(`    ${String(t.description).slice(0, 70)}`));
    }
  } catch (error) {
    spinner.fail('Failed to fetch tools');
    console.error(chalk.red((error as Error).message));
    process.exit(1);
  }
}

export async function integrationsExecuteCommand(toolName: string, options: { app?: string; data?: string; userId?: string }) {
  const appId = await requireAppId(options.app);

  let params: Record<string, unknown> = {};
  if (options.data) {
    try {
      params = JSON.parse(options.data);
    } catch {
      console.error(chalk.red('✗ --data must be valid JSON'));
      process.exit(1);
    }
  }

  const spinner = ora(`Executing ${toolName}...`).start();
  try {
    const result = await executeIntegrationTool(appId, toolName, params, options.userId);
    spinner.stop();
    if (result.successful) {
      console.log(chalk.green('\n✓ Tool executed successfully\n'));
      console.log(JSON.stringify(result.data, null, 2));
    } else {
      console.log(chalk.yellow('\n⚠ Tool returned an error\n'));
      console.log(chalk.red(result.error || 'Unknown error'));
    }
  } catch (error) {
    spinner.fail(`Failed to execute ${toolName}`);
    console.error(chalk.red((error as Error).message));
    process.exit(1);
  }
}
