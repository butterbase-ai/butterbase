#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { renderError } from '../src/lib/errors.js';
import { initCommand } from '../src/commands/init.js';
import { loginCommand, logoutCommand, configGetCommand, configSetCommand } from '../src/commands/config.js';
import { appsListCommand, appsCreateCommand, appsUseCommand, appsDeleteCommand, appsPauseCommand, appsResumeCommand, appsLinkSubstrateCommand, appsUnlinkSubstrateCommand } from '../src/commands/apps.js';
import { schemaGetCommand, schemaApplyCommand } from '../src/commands/schema.js';
import { functionsListCommand, functionsDeployCommand, functionsLogsCommand, functionsDeleteCommand, functionsInvokeCommand, functionsEnvSetCommand, functionsEnvListCommand } from '../src/commands/functions.js';
import { storageListCommand, storageUploadCommand, storageDeleteCommand, storageConfigCommand } from '../src/commands/storage.js';
import { realtimeEnableCommand, realtimeConfigCommand, realtimeDisableCommand } from '../src/commands/realtime.js';
import { deployCommand } from '../src/commands/deploy.js';
import { deployFromSource } from '../src/commands/deploy-from-source.js';
import { deployEdgeSsrCommand } from '../src/commands/deploy-edge-ssr.js';
import { deployEdgeSsrFromSource } from '../src/commands/deploy-edge-ssr-from-source.js';
import { dataQueryCommand, dataInsertCommand } from '../src/commands/data.js';
import { envSetCommand, envListCommand, envSetFileCommand } from '../src/commands/env.js';
import { keysGenerateCommand, keysListCommand, keysRevokeCommand } from '../src/commands/keys.js';
import { statusCommand } from '../src/commands/status.js';
import { openCommand } from '../src/commands/open.js';
import { pluginSetupCommand } from '../src/commands/plugin.js';
import {
  integrationsListCommand,
  integrationsConfigCommand,
  integrationsConfigureCommand,
  integrationsDisableCommand,
  integrationsConnectCommand,
  integrationsConnectionsCommand,
  integrationsDisconnectCommand,
  integrationsToolsCommand,
  integrationsExecuteCommand,
} from '../src/commands/integrations.js';
import {
  domainsListCommand,
  domainsAddCommand,
  domainsStatusCommand,
  domainsVerifyCommand,
  domainsDeleteCommand,
} from '../src/commands/domains.js';
import { partnersListCommand, partnersCurlCommand } from '../src/commands/partners.js';
import { rlsListCommand, rlsCreateCommand, rlsEnableCommand, rlsDeleteCommand } from '../src/commands/rls.js';
import {
  billingStatusCommand,
  billingPortalCommand,
  billingTopupCommand,
  billingCapGetCommand,
  billingCapRaiseCommand,
  billingPlansCommand,
  billingUsageCommand,
} from '../src/commands/billing.js';
import {
  ragCollectionsListCommand,
  ragCollectionsCreateCommand,
  ragCollectionsGetCommand,
  ragCollectionsDeleteCommand,
  ragIngestCommand,
  ragDocsListCommand,
  ragDocsDeleteCommand,
  ragQueryCommand,
} from '../src/commands/rag.js';
import {
  doDeployCommand,
  doListCommand,
  doGetCommand,
  doDeleteCommand,
  doUsageCommand,
  doEnvListCommand,
  doEnvSetCommand,
  doEnvUnsetCommand,
} from '../src/commands/do.js';
import {
  aiChatCommand,
  aiEmbedCommand,
  aiModelsCommand,
  aiConfigGetCommand,
  aiConfigSetCommand,
  aiUsageCommand,
  aiMeetingsStartCommand,
  aiMeetingsGetCommand,
  aiMeetingsListCommand,
  aiMeetingsStopCommand,
  aiMeetingsEstimateCommand,
  aiMeetingsUsageCommand,
  aiMeetingsWebhookCommand,
} from '../src/commands/ai.js';
import {
  oauthConfigureCommand, oauthListCommand, oauthGetCommand, oauthUpdateCommand, oauthDeleteCommand,
} from '../src/commands/oauth.js';
import { auditQueryCommand } from '../src/commands/audit.js';
import {
  appConfigGetCommand, appCorsCommand, appJwtCommand, appStorageCommand,
  appAccessModeCommand, appSecureCommand,
} from '../src/commands/app-config.js';
import { regionsListCommand } from '../src/commands/regions.js';
import {
  moveCommand, migrationStatusCommand, migrationActiveCommand,
  migrationAbortCommand, migrationReverseCommand,
  replicasListCommand, replicaTeardownCommand,
} from '../src/commands/move.js';
import {
  plansListCommand, plansCreateCommand, plansUpdateCommand,
  productsListCommand, productsCreateCommand, productsUpdateCommand,
  subscribeCommand, subscriptionCommand, cancelCommand,
  purchaseCommand, ordersListCommand, ordersGetCommand,
} from '../src/commands/app-billing.js';
import {
  kvGetCommand, kvSetCommand, kvDelCommand, kvLsCommand,
  kvStatsCommand, kvFlushCommand, kvRulesCommand,
  kvExposeCommand, kvUnexposeCommand, kvApplyCommand,
} from '../src/commands/kv.js';
import {
  substrateLedgerCommand,
  substrateLedgerInspectCommand,
  substrateProposeCommand,
  substrateApproveCommand,
  substrateRejectCommand,
  substrateEntitiesListCommand,
  substrateEntitiesGetCommand,
  substrateEntitiesUpdateCommand,
  substrateArtifactsListCommand,
  substrateArtifactsGetCommand,
  substrateMemoryCommand,
  substrateOutboxListCommand,
  substrateOutboxCancelCommand,
  substrateOutboxRetryCommand,
  substrateRulesListCommand,
  substrateRulesGetCommand,
  substrateRulesCreateCommand,
  substrateRulesUpdateCommand,
  substrateRulesDeleteCommand,
  substrateRulesEnableCommand,
  substrateRulesDisableCommand,
  substrateRulesFiringsCommand,
  substrateSnapshotsCommand,
  substrateSettingsShowCommand,
  substrateSettingsYoloCommand,
} from '../src/commands/substrate.js';
import {
  repoInitCommand, repoPushCommand, repoPullCommand,
  repoStatusCommand, repoLogCommand, repoWipeCommand,
} from '../src/commands/repo.js';
import { visibilityCommand } from '../src/commands/visibility.js';
import {
  agentsListCommand,
  agentsGetCommand,
  agentsCreateCommand,
  agentsUpdateCommand,
  agentsDeleteCommand,
} from '../src/commands/agents.js';
import { cloneCommand, cloneRetryCommand } from '../src/commands/clone.js';
import { templatesCommand } from '../src/commands/templates.js';

function resolveVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // Compiled: dist/bin/butterbase.js → ../../package.json
  // Source (tsx): bin/butterbase.ts → ../package.json
  for (const rel of ['../package.json', '../../package.json']) {
    try {
      return JSON.parse(readFileSync(join(here, rel), 'utf8')).version;
    } catch {}
  }
  return '0.0.0-unknown';
}

const program = new Command();

program
  .name('butterbase')
  .description('Butterbase CLI - Backend as a Service')
  .version(resolveVersion());

// Init
program
  .command('init [template]')
  .description('Initialize a new Butterbase project')
  .action(initCommand);

// Login/Logout
program
  .command('login')
  .description('Authenticate with Butterbase')
  .action(loginCommand);

program
  .command('logout')
  .description('Clear authentication credentials')
  .action(logoutCommand);

// Config
const config = program.command('config').description('Manage configuration');

config
  .command('get')
  .description('Show current configuration')
  .action(configGetCommand);

config
  .command('set <key> <value>')
  .description('Set a configuration value')
  .action(configSetCommand);

// Apps
const apps = program.command('apps').description('Manage apps');

apps
  .command('list')
  .description('List all apps')
  .action(appsListCommand);

apps
  .command('create [name]')
  .description('Create a new app')
  .action(appsCreateCommand);

apps
  .command('use <app-id>')
  .description('Set the current app')
  .action(appsUseCommand);

apps
  .command('delete <app-id>')
  .description('Delete an app')
  .action(appsDeleteCommand);

apps
  .command('pause [app-id]')
  .description('Pause an app — kill-switch that returns 503 for all data-plane traffic')
  .option('--reason <text>', 'Human-readable reason, surfaced in 503 responses')
  .action(appsPauseCommand);

apps
  .command('resume [app-id]')
  .description('Resume a paused app — restore data-plane traffic')
  .action(appsResumeCommand);

apps
  .command('link-substrate [app-id]')
  .description('Link this app to your substrate — wires ctx.substrate into deployed functions')
  .action(appsLinkSubstrateCommand);

apps
  .command('unlink-substrate [app-id]')
  .description('Unlink this app from your substrate')
  .action(appsUnlinkSubstrateCommand);

const appsConfig = apps.command('config').description('Read or update the app\'s server-side config');

appsConfig
  .command('get')
  .description('Show the app\'s full config')
  .option('--app <appId>', 'Override current app')
  .option('--json', 'Output raw JSON')
  .action((opts) => appConfigGetCommand(opts));

appsConfig
  .command('cors')
  .description('Update CORS config')
  .option('--app <appId>', 'Override current app')
  .option('--allowed-origin <origin>', 'Allowed origin (repeatable)', (v, prev: string[]) => prev.concat(v), [] as string[])
  .option('--allowed-method <method>', 'Allowed method (repeatable)', (v, prev: string[]) => prev.concat(v), [] as string[])
  .option('--allowed-header <header>', 'Allowed header (repeatable)', (v, prev: string[]) => prev.concat(v), [] as string[])
  .option('--allow-credentials <bool>', '(true|false)', (v) => v === 'true')
  .option('--json', 'Output raw JSON')
  .action((opts) => appCorsCommand(opts));

appsConfig
  .command('jwt')
  .description('Update JWT TTLs')
  .option('--app <appId>', 'Override current app')
  .option('--access-token-ttl <duration>', 'e.g. "15m", "1h"')
  .option('--refresh-token-ttl-days <n>', 'Refresh token lifetime in days', parseInt)
  .option('--json', 'Output raw JSON')
  .action((opts) => appJwtCommand(opts));

appsConfig
  .command('storage')
  .description('Update storage config')
  .option('--app <appId>', 'Override current app')
  .option('--public-read <bool>', 'Public-read default (true|false)', (v) => v === 'true')
  .option('--max-file-size-mb <n>', 'Per-file size cap in MB', parseInt)
  .option('--allowed-content-type <ct>', 'Allowed content-type (repeatable)', (v, prev: string[]) => prev.concat(v), [] as string[])
  .option('--json', 'Output raw JSON')
  .action((opts) => appStorageCommand(opts));

appsConfig
  .command('access-mode <mode>')
  .description('Set access mode: public | authenticated')
  .option('--app <appId>', 'Override current app')
  .option('--json', 'Output raw JSON')
  .action((mode, opts) => appAccessModeCommand(mode, opts));

appsConfig
  .command('secure')
  .description('Enable RLS + access-mode in one shot')
  .option('--app <appId>', 'Override current app')
  .option('--table <name>', 'Table to secure (repeatable)', (v, prev: string[]) => prev.concat(v), [] as string[])
  .option('--user-column <col>', 'User-id column name (default: user_id)')
  .option('--access-mode <mode>', 'public | authenticated')
  .option('--json', 'Output raw JSON')
  .action((opts) => appSecureCommand(opts));

apps
  .command('move <appId> <destRegion>')
  .description('Migrate an app to another region')
  .option('--follow', 'Poll status until terminal')
  .option('--json', 'Output raw JSON')
  .action((appId, destRegion, opts) => moveCommand(appId, destRegion, opts));

const appsMigrations = apps.command('migrations').description('Read or control in-flight migrations');

appsMigrations
  .command('status <appId> <migrationId>')
  .description('Get status of a specific migration')
  .option('--json', 'Output raw JSON')
  .action((appId, migrationId, opts) => migrationStatusCommand(appId, migrationId, opts));

appsMigrations
  .command('active [appId]')
  .description('Show the currently-active migration for an app')
  .option('--app <appId>', 'Override current app')
  .option('--json', 'Output raw JSON')
  .action((appId, opts) => migrationActiveCommand(appId, opts));

appsMigrations
  .command('abort <appId> <migrationId>')
  .description('Cancel a migration that has not yet reached cutover')
  .option('--json', 'Output raw JSON')
  .action((appId, migrationId, opts) => migrationAbortCommand(appId, migrationId, opts));

appsMigrations
  .command('reverse <appId> <migrationId>')
  .description('Roll a completed migration back to source')
  .option('--json', 'Output raw JSON')
  .action((appId, migrationId, opts) => migrationReverseCommand(appId, migrationId, opts));

const appsReplicas = apps.command('replicas').description('Manage retained source replicas after a move');

appsReplicas
  .command('list')
  .description('List active retained source replicas')
  .option('--json', 'Output raw JSON')
  .action((opts) => replicasListCommand(opts));

appsReplicas
  .command('teardown <migrationId>')
  .description('Decommission a retained source replica')
  .option('--json', 'Output raw JSON')
  .action((migrationId, opts) => replicaTeardownCommand(migrationId, opts));

// Schema
const schema = program.command('schema').description('Manage database schema');

schema
  .command('get')
  .description('Get current schema')
  .option('--app <app-id>', 'App ID (uses current app if not specified)')
  .option('--output <file>', 'Save schema to file')
  .action(schemaGetCommand);

schema
  .command('apply <file>')
  .description('Apply schema from file')
  .option('--app <app-id>', 'App ID (uses current app if not specified)')
  .option('--dry-run', 'Preview changes without applying')
  .option('--name <name>', 'Migration name')
  .action(schemaApplyCommand);

// Functions
const functions = program.command('functions').description('Manage serverless functions');

functions
  .command('list')
  .description('List deployed functions')
  .option('--app <app-id>', 'App ID (uses current app if not specified)')
  .action(functionsListCommand);

functions
  .command('deploy <file>')
  .description('Deploy a function')
  .option('--app <app-id>', 'App ID (uses current app if not specified)')
  .option('--name <name>', 'Function name (defaults to filename)')
  .option('--trigger <type>', 'Trigger type (http, cron, s3_upload, webhook, websocket)', 'http')
  .option('--trigger-config <json>', 'Trigger config as JSON (e.g. \'{"schedule":"*/5 * * * *"}\')')
  .option('--description <desc>', 'Function description')
  .option('--env <kv>', 'Env var as KEY=value (repeatable)', (v, prev: string[]) => prev.concat(v), [] as string[])
  .option('--timeout-ms <n>', 'Per-invocation timeout (ms)', parseInt)
  .option('--memory-mb <n>', 'Memory limit (MB)', parseInt)
  .option('--agent-tool', 'Expose this function to agents as a tool')
  .option('--agent-tool-description <desc>', 'Description shown to the LLM when this function is exposed as an agent tool')
  .option('--agent-tool-mode <mode>', 'read_only (default) | read_write (read_write requires HITL approval)')
  .option('--agent-tool-exposed-to <scope>', 'developer_only (default) | end_user')
  .action(functionsDeployCommand);

functions
  .command('logs <function-name>')
  .description('View function logs')
  .option('--app <app-id>', 'App ID (uses current app if not specified)')
  .option('--level <level>', 'Filter by log level (error, all)')
  .option('--limit <number>', 'Number of logs to fetch', '100')
  .option('--include-deleted', 'Include logs for soft-deleted functions (post-incident forensics)')
  .action(functionsLogsCommand);

functions
  .command('delete <function-name>')
  .description('Delete a function')
  .option('--app <app-id>', 'App ID (uses current app if not specified)')
  .action(functionsDeleteCommand);

functions
  .command('invoke <function-name>')
  .description('Invoke a deployed function')
  .option('--app <app-id>', 'App ID (uses current app if not specified)')
  .option('--data <json>', 'Request body as JSON string')
  .option('--json', 'Output as JSON')
  .action(functionsInvokeCommand);

const functionsEnvCmd = functions.command('env').description('Manage function environment variables');

functionsEnvCmd
  .command('set <function-name> <vars...>')
  .description('Set env vars (KEY=VALUE pairs)')
  .option('--app <app-id>', 'App ID (uses current app if not specified)')
  .action(functionsEnvSetCommand);

functionsEnvCmd
  .command('list <function-name>')
  .description('List env var keys (values are write-only)')
  .option('--app <app-id>', 'App ID (uses current app if not specified)')
  .option('--json', 'Output as JSON')
  .action(functionsEnvListCommand);

// Storage
const storage = program.command('storage').description('Manage file storage');

storage
  .command('list')
  .description('List storage objects')
  .option('--app <app-id>', 'App ID (uses current app if not specified)')
  .action(storageListCommand);

storage
  .command('upload <file>')
  .description('Upload a file')
  .option('--app <app-id>', 'App ID (uses current app if not specified)')
  .option('--public', 'Mark file as publicly downloadable by any authenticated user')
  .action(storageUploadCommand);

storage
  .command('delete <object-id>')
  .description('Delete a storage object')
  .option('--app <app-id>', 'App ID (uses current app if not specified)')
  .action(storageDeleteCommand);

storage
  .command('config')
  .description('View or update storage configuration')
  .option('--app <app-id>', 'App ID (uses current app if not specified)')
  .option('--public-read <boolean>', 'Enable/disable public read access (true/false)')
  .action(storageConfigCommand);

// Realtime
const realtime = program.command('realtime').description('Manage realtime subscriptions');

realtime
  .command('enable <tables...>')
  .description('Enable realtime on tables')
  .option('--app <app-id>', 'App ID (uses current app if not specified)')
  .action(realtimeEnableCommand);

realtime
  .command('config')
  .description('Show realtime configuration')
  .option('--app <app-id>', 'App ID (uses current app if not specified)')
  .option('--json', 'Output as JSON')
  .action(realtimeConfigCommand);

realtime
  .command('disable <table>')
  .description('Disable realtime on a table')
  .option('--app <app-id>', 'App ID (uses current app if not specified)')
  .action(realtimeDisableCommand);

// Deploy (top-level — most common command)
program
  .command('deploy [directory]')
  .description('Deploy frontend to Butterbase')
  .option('--app <app-id>', 'App ID')
  .option('--framework <type>', 'Framework type (react-vite, nextjs-static, static, other)')
  .option('--json', 'Output as JSON')
  .option('--from-source', 'Build from source (zip + remote build) instead of uploading a prebuilt directory')
  .option('--build-command <cmd>', 'Build command (only with --from-source, default: npm run build)')
  .option('--output-dir <path>', 'Build output directory (only with --from-source, default: dist)')
  .option('--from <path>', 'Project root to zip (only with --from-source, default: cwd)')
  .action((directory, options) => {
    if (options.fromSource) {
      return deployFromSource({
        app: options.app,
        fromPath: options.from,
        buildCommand: options.buildCommand,
        outputDir: options.outputDir,
      });
    }
    return deployCommand(directory, options);
  });

// Deploy Edge SSR
program
  .command('deploy:edge-ssr [directory]')
  .description('Deploy a Cloudflare Workers Edge SSR build (e.g. Next.js via @cloudflare/next-on-pages)')
  .option('--app <app-id>', 'App ID')
  .option('--framework <type>', 'Framework type (nextjs-edge, remix-edge, other-edge)', 'nextjs-edge')
  .option('--from <path>', 'Override source directory (default: .vercel/output/static/ or cwd)')
  .option('--json', 'Output as JSON')
  .option('--from-source', 'Build from source (zip + remote build) instead of uploading a prebuilt directory')
  .option('--build-command <cmd>', 'Build command (only with --from-source, default: npx @cloudflare/next-on-pages)')
  .option('--output-dir <path>', 'Build output directory (only with --from-source, default: .vercel/output/static)')
  .action((directory, options) => {
    if (options.fromSource) {
      return deployEdgeSsrFromSource({
        app: options.app,
        fromPath: options.from,
        buildCommand: options.buildCommand,
        outputDir: options.outputDir,
        framework: options.framework,
      });
    }
    return deployEdgeSsrCommand(directory, options);
  });

// Status (top-level)
program
  .command('status')
  .description('Show app overview')
  .option('--app <app-id>', 'App ID')
  .option('--json', 'Output as JSON')
  .action(statusCommand);

// Open (top-level)
program
  .command('open')
  .description('Open app in browser')
  .option('--app <app-id>', 'App ID')
  .option('--api', 'Open API URL instead of frontend')
  .action(openCommand);

// Data
const data = program.command('data').description('Query and manage table data');

data
  .command('query <table>')
  .description('Query rows from a table')
  .option('--app <app-id>', 'App ID')
  .option('--filter <filter...>', 'Filter (e.g. status=eq.active)')
  .option('--select <columns>', 'Columns to return')
  .option('--order <order>', 'Sort order (e.g. created_at.desc)')
  .option('--limit <n>', 'Max rows', '20')
  .option('--offset <n>', 'Skip rows')
  .option('--json', 'Output as JSON')
  .action(dataQueryCommand);

data
  .command('insert <table>')
  .description('Insert a row into a table')
  .option('--app <app-id>', 'App ID')
  .option('--data <json>', 'Row data as JSON string')
  .option('--file <path>', 'Read row data from JSON file')
  .option('--json', 'Output as JSON')
  .action(dataInsertCommand);

// Env
const env = program.command('env').description('Manage frontend environment variables');

env
  .command('set <vars...>')
  .description('Set env vars (KEY=VALUE pairs)')
  .option('--app <app-id>', 'App ID')
  .action(envSetCommand);

env
  .command('list')
  .description('List env var keys')
  .option('--app <app-id>', 'App ID')
  .option('--json', 'Output as JSON')
  .action(envListCommand);

env
  .command('set-file <path>')
  .description('Set env vars from a .env file')
  .option('--app <app-id>', 'App ID')
  .action(envSetFileCommand);

// Keys
const keys = program.command('keys').description('Manage API keys');

keys
  .command('generate [name]')
  .description('Generate a new API key')
  .option('--scope <scope>', 'Add a permission scope (repeatable)', (v, prev: string[]) => prev.concat(v), [] as string[])
  .option('--substrate', 'Generate a substrate-scoped key (bb_sub_*) usable against /v1/me/substrate/* routes')
  .option('--json', 'Output as JSON')
  .action(keysGenerateCommand);

keys
  .command('list')
  .description('List API keys')
  .option('--json', 'Output as JSON')
  .action(keysListCommand);

keys
  .command('revoke <key-id>')
  .description('Revoke an API key')
  .action(keysRevokeCommand);

// Plugin
const plugin = program.command('plugin').description('Manage AI agent integration');

plugin
  .command('setup')
  .description('Set up Claude Code / MCP integration')
  .action(pluginSetupCommand);

// Integrations
const integrations = program.command('integrations').description('Manage third-party integrations');

integrations
  .command('list')
  .description('List available integrations')
  .option('--app <app-id>', 'App ID')
  .option('--search <query>', 'Search by name')
  .action(integrationsListCommand);

integrations
  .command('config')
  .description('Show configured integrations')
  .option('--app <app-id>', 'App ID')
  .action(integrationsConfigCommand);

integrations
  .command('configure <toolkit>')
  .description('Enable a toolkit for the app')
  .option('--app <app-id>', 'App ID')
  .option('--display-name <name>', 'Human-readable display name')
  .option('--scope <scope>', 'Add a scope (repeatable)', (v, prev: string[]) => prev.concat(v), [] as string[])
  .action(integrationsConfigureCommand);

integrations
  .command('disable <toolkit>')
  .description('Disable a toolkit')
  .option('--app <app-id>', 'App ID')
  .action(integrationsDisableCommand);

integrations
  .command('connect <toolkit>')
  .description('Generate OAuth URL for an end-user')
  .option('--app <app-id>', 'App ID')
  .option('--redirect-url <url>', 'URL to redirect after OAuth')
  .option('--user-id <uuid>', 'User ID (for API key auth)')
  .option('--scope <scope>', 'Add a scope (repeatable)', (v, prev: string[]) => prev.concat(v), [] as string[])
  .action(integrationsConnectCommand);

integrations
  .command('connections')
  .description('List connected accounts')
  .option('--app <app-id>', 'App ID')
  .action(integrationsConnectionsCommand);

integrations
  .command('disconnect <connection-id>')
  .description('Disconnect a user account')
  .option('--app <app-id>', 'App ID')
  .action(integrationsDisconnectCommand);

integrations
  .command('tools [toolkit]')
  .description('List available tools for a toolkit')
  .option('--app <app-id>', 'App ID')
  .action(integrationsToolsCommand);

integrations
  .command('execute <tool-name>')
  .description('Execute an integration tool')
  .option('--app <app-id>', 'App ID')
  .option('--data <json>', 'Tool parameters as JSON string')
  .option('--user-id <uuid>', 'User ID (for API key auth)')
  .action(integrationsExecuteCommand);

// Custom Domains
const domains = program.command('domains').description('Manage custom domains');

domains
  .command('list')
  .description('List custom domains')
  .option('--app <app-id>', 'App ID')
  .action(domainsListCommand);

domains
  .command('add <hostname>')
  .description('Add a custom domain')
  .option('--app <app-id>', 'App ID')
  .action(domainsAddCommand);

domains
  .command('status <domain-id>')
  .description('Check domain verification status')
  .option('--app <app-id>', 'App ID')
  .action(domainsStatusCommand);

domains
  .command('verify <domain-id>')
  .description('Re-verify a pending domain')
  .option('--app <app-id>', 'App ID')
  .action(domainsVerifyCommand);

domains
  .command('delete <domain-id>')
  .description('Remove a custom domain')
  .option('--app <app-id>', 'App ID')
  .option('-y, --yes', 'Skip confirmation')
  .action(domainsDeleteCommand);

// Durable Objects
const doCmd = program.command('do').description('Manage Durable Objects');

doCmd
  .command('deploy <file>')
  .description('Deploy a Durable Object class')
  .option('--app <appId>', 'App ID')
  .option('--name <name>', 'URL name (defaults to file basename)')
  .option('--access-mode <mode>', 'public | authenticated | service_key', 'authenticated')
  .option('--json', 'Output as JSON')
  .action(doDeployCommand);

doCmd
  .command('list')
  .description('List Durable Objects')
  .option('--app <appId>', 'App ID')
  .option('--json', 'Output as JSON')
  .action(doListCommand);

doCmd
  .command('get <name>')
  .description('Get a Durable Object class')
  .option('--app <appId>', 'App ID')
  .option('--code', 'Print only the source code')
  .option('--json', 'Output as JSON')
  .action(doGetCommand);

doCmd
  .command('delete <name>')
  .description('Delete a Durable Object class')
  .option('--app <appId>', 'App ID')
  .action(doDeleteCommand);

doCmd
  .command('usage <name>')
  .description('Show current-month DO usage')
  .option('--app <appId>', 'App ID')
  .option('--json', 'Output as JSON')
  .action(doUsageCommand);

const doEnvCmd = doCmd.command('env').description('Manage env vars exposed to DO scripts as `env.KEY`');

doEnvCmd
  .command('list')
  .description('List configured DO env var keys (values are write-only)')
  .option('--app <appId>', 'App ID')
  .option('--json', 'Output as JSON')
  .action(doEnvListCommand);

doEnvCmd
  .command('set <key> <value>')
  .description('Set or update one DO env var (triggers Worker redeploy if classes are active)')
  .option('--app <appId>', 'App ID')
  .action(doEnvSetCommand);

doEnvCmd
  .command('unset <key>')
  .description('Remove one DO env var (triggers Worker redeploy if classes are active)')
  .option('--app <appId>', 'App ID')
  .action(doEnvUnsetCommand);

// Partners
const partners = program.command('partners').description('Hackathon partner APIs (Seedance, Z.AI, etc.)');
partners
  .command('list')
  .description('List partner APIs configured for a hackathon')
  .requiredOption('--hackathon <slug>', 'Hackathon slug')
  .option('--app <id>', 'App id (defaults to current)')
  .action(partnersListCommand);
partners
  .command('curl <slug> <path>')
  .description('Print or run a curl command against a partner via the Butterbase proxy')
  .requiredOption('--hackathon <slug>', 'Hackathon slug')
  .option('--app <id>', 'App id (defaults to current)')
  .option('-X, --method <method>', 'HTTP method', 'GET')
  .option('-d, --data <body>', 'Request JSON body')
  .option('-x, --execute', 'Execute the curl instead of just printing it')
  .action((slug, path, opts) => partnersCurlCommand(slug, path, opts));

// RLS
const rls = program.command('rls').description('Manage Row-Level Security policies');

rls
  .command('list')
  .description('List RLS policies')
  .option('--app <app-id>', 'App ID (uses current app if not specified)')
  .option('--json', 'Output as JSON')
  .action(rlsListCommand);

rls
  .command('create')
  .description('Create an RLS policy (user-isolation or custom)')
  .option('--app <app-id>', 'App ID (uses current app if not specified)')
  .option('--table <table>', 'Target table name')
  .option('--user-isolation', 'Enable user-isolation mode (uses --table, --user-column, --public-read-column)')
  .option('--user-column <col>', 'Column containing the user ID')
  .option('--public-read-column <col>', 'Boolean column enabling public read override')
  .option('--policy-name <name>', 'Policy name (custom mode)')
  .option('--command <cmd>', 'SQL command (SELECT, INSERT, UPDATE, DELETE, ALL)')
  .option('--using <expr>', 'USING expression')
  .option('--with-check <expr>', 'WITH CHECK expression')
  .option('--restrictive', 'Create as RESTRICTIVE policy')
  .option('--role <role>', 'Restrict to a Postgres role (anon | user)')
  .option('--json', 'Output as JSON')
  .action(rlsCreateCommand);

rls
  .command('enable <table>')
  .description('Enable RLS on a table')
  .option('--app <app-id>', 'App ID (uses current app if not specified)')
  .action(rlsEnableCommand);

rls
  .command('delete <table>')
  .description('Delete RLS policies on a table (all by default, or named with --policy)')
  .option('--app <app-id>', 'App ID (uses current app if not specified)')
  .option('--policy <name>', 'Delete only this named policy')
  .action(rlsDeleteCommand);

// Billing
const billing = program.command('billing').description('Manage billing, plans, and spending');

billing
  .command('status')
  .description('Show current plan and billing status')
  .option('--json', 'Output as JSON')
  .action(billingStatusCommand);

billing
  .command('portal')
  .description('Print the billing portal URL')
  .option('--json', 'Output as JSON')
  .action(billingPortalCommand);

billing
  .command('topup <amount>')
  .description('Add credit balance (amount in USD)')
  .option('--json', 'Output as JSON')
  .action(billingTopupCommand);

billing
  .command('cap')
  .description('Show current spending cap')
  .option('--json', 'Output as JSON')
  .action(billingCapGetCommand);

billing
  .command('cap:raise')
  .description('Raise the spending cap')
  .option('--raise-by <amount>', 'Amount in USD to raise the cap by')
  .option('--json', 'Output as JSON')
  .action(billingCapRaiseCommand);

billing
  .command('plans')
  .description('List available plans')
  .option('--json', 'Output as JSON')
  .action(billingPlansCommand);

billing
  .command('usage')
  .description('Show usage metrics')
  .option('--start <date>', 'Start date (ISO 8601)')
  .option('--end <date>', 'End date (ISO 8601)')
  .option('--meter <type>', 'Filter by meter type')
  .option('--json', 'Output as JSON')
  .action(billingUsageCommand);

// RAG
const rag = program.command('rag').description('Manage RAG collections and documents');

const ragCollections = rag.command('collections').description('Manage RAG collections');

ragCollections
  .command('list')
  .description('List RAG collections')
  .option('--app <app-id>', 'App ID (uses current app if not specified)')
  .option('--json', 'Output as JSON')
  .action(ragCollectionsListCommand);

ragCollections
  .command('create <name>')
  .description('Create a RAG collection')
  .option('--app <app-id>', 'App ID (uses current app if not specified)')
  .option('--description <text>', 'Collection description')
  .option('--access-mode <mode>', 'Access mode (public, authenticated, service_key)')
  .option('--chunk-size <n>', 'Chunk size in tokens')
  .option('--chunk-overlap <n>', 'Chunk overlap in tokens')
  .option('--json', 'Output as JSON')
  .action(ragCollectionsCreateCommand);

ragCollections
  .command('get <name>')
  .description('Get a RAG collection')
  .option('--app <app-id>', 'App ID (uses current app if not specified)')
  .option('--json', 'Output as JSON')
  .action(ragCollectionsGetCommand);

ragCollections
  .command('delete <name>')
  .description('Delete a RAG collection')
  .option('--app <app-id>', 'App ID (uses current app if not specified)')
  .action(ragCollectionsDeleteCommand);

rag
  .command('ingest <file-or-text>')
  .description('Ingest a document or text into a RAG collection')
  .requiredOption('--collection <name>', 'Target collection name')
  .option('--app <app-id>', 'App ID (uses current app if not specified)')
  .option('--text', 'Treat the argument as raw text instead of a file path')
  .option('--filename <name>', 'Override the filename stored with the document')
  .option('--metadata <json>', 'Document metadata as JSON string')
  .option('--json', 'Output as JSON')
  .action(ragIngestCommand);

const ragDocs = rag.command('docs').description('Manage RAG documents');

ragDocs
  .command('list <collection>')
  .description('List documents in a RAG collection')
  .option('--app <app-id>', 'App ID (uses current app if not specified)')
  .option('--json', 'Output as JSON')
  .action(ragDocsListCommand);

ragDocs
  .command('delete <collection> <doc-id>')
  .description('Delete a document from a RAG collection')
  .option('--app <app-id>', 'App ID (uses current app if not specified)')
  .action(ragDocsDeleteCommand);

rag
  .command('query <collection>')
  .description('Query a RAG collection')
  .option('--app <app-id>', 'App ID (uses current app if not specified)')
  .requiredOption('-q, --query <text>', 'Query string')
  .option('--top-k <n>', 'Number of results to return')
  .option('--threshold <n>', 'Minimum similarity threshold')
  .option('--synthesize', 'Synthesize an answer from retrieved chunks')
  .option('--model <model>', 'LLM model to use for synthesis')
  .option('--json', 'Output as JSON')
  .action(ragQueryCommand);

// AI Gateway
const ai = program.command('ai').description('Use the app\'s AI gateway (chat, embeddings, models, BYOK, usage)');

ai
  .command('chat <prompt>')
  .description('Send a single-turn chat completion')
  .option('--app <appId>', 'Override current app')
  .option('--model <model>', 'Model id (default: app default)')
  .option('--temperature <n>', 'Sampling temperature', parseFloat)
  .option('--max-tokens <n>', 'Max output tokens', parseInt)
  .option('--system <message>', 'Prepend a system message')
  .option('--json', 'Output raw JSON')
  .action((prompt, opts) => aiChatCommand(prompt, opts));

ai
  .command('embed <input...>')
  .description('Embed text(s) into vectors')
  .option('--app <appId>', 'Override current app')
  .option('--model <model>', 'Embedding model')
  .option('--json', 'Output raw JSON')
  .action((input, opts) => aiEmbedCommand(input, opts));

ai
  .command('models')
  .description('List available AI models')
  .option('--app <appId>', 'Override current app')
  .option('--json', 'Output raw JSON')
  .action((opts) => aiModelsCommand(opts));

const aiConfig = ai.command('config').description('Read or update AI config');
aiConfig
  .command('get')
  .option('--app <appId>', 'Override current app')
  .option('--json', 'Output raw JSON')
  .action((opts) => aiConfigGetCommand(opts));
aiConfig
  .command('set')
  .option('--app <appId>', 'Override current app')
  .option('--default-model <model>')
  .option('--allowed-models <models...>')
  .option('--max-tokens-per-request <n>', 'Cap on tokens per request', parseInt)
  .option('--byok-key <key>', 'Set or clear BYOK key (empty string clears)')
  .option('--json', 'Output raw JSON')
  .action((opts) => aiConfigSetCommand(opts));

ai
  .command('usage')
  .description('AI token + cost usage over a window')
  .option('--app <appId>', 'Override current app')
  .option('--start-date <date>', 'ISO date')
  .option('--end-date <date>', 'ISO date')
  .option('--json', 'Output raw JSON')
  .action((opts) => aiUsageCommand({
    app: opts.app, startDate: opts.startDate, endDate: opts.endDate, json: opts.json,
  }));

// ─── ai meetings ────────────────────────────────────────────────────────────
const aiMeetings = ai.command('meetings').description('Meeting bots that join Zoom/Meet/Teams/Webex calls and return recordings + transcripts');

aiMeetings
  .command('start <meetingUrl>')
  .description('Spawn a meeting bot')
  .option('--app <appId>', 'Override current app')
  .option('--no-transcript', 'Disable transcription')
  .option('--recording <mode>', '"mp4" (default), "audio_only", or "false"', 'mp4')
  .option('--json', 'Output raw JSON')
  .action((meetingUrl, opts) => aiMeetingsStartCommand(meetingUrl, {
    app: opts.app, transcript: opts.transcript, recording: opts.recording, json: opts.json,
  }));

aiMeetings
  .command('get <meetingId>')
  .description('Get current status + recording/transcript URLs (when ready)')
  .option('--app <appId>', 'Override current app')
  .option('--json', 'Output raw JSON')
  .action((meetingId, opts) => aiMeetingsGetCommand(meetingId, opts));

aiMeetings
  .command('list')
  .description('List meeting bots for this app')
  .option('--app <appId>', 'Override current app')
  .option('--status <phase>', 'Filter to a lifecycle phase (joining|waiting_room|in_call|recording|ended|done|fatal)')
  .option('--limit <n>', 'Page size', parseInt)
  .option('--cursor <s>', 'Pagination cursor')
  .option('--json', 'Output raw JSON')
  .action((opts) => aiMeetingsListCommand(opts));

aiMeetings
  .command('stop <meetingId>')
  .description('Force a bot to leave its call')
  .option('--app <appId>', 'Override current app')
  .action((meetingId, opts) => aiMeetingsStopCommand(meetingId, opts));

aiMeetings
  .command('estimate <durationMinutes>')
  .description('Predict the USD charge for a session at the given duration')
  .option('--app <appId>', 'Override current app')
  .option('--no-transcript', 'Skip transcription in the estimate')
  .option('--json', 'Output raw JSON')
  .action((durationMinutes, opts) => aiMeetingsEstimateCommand({
    app: opts.app, durationMinutes: parseInt(durationMinutes), transcript: opts.transcript, json: opts.json,
  }));

aiMeetings
  .command('usage')
  .description('Recent actor_usage_logs rows for this app')
  .option('--app <appId>', 'Override current app')
  .option('--json', 'Output raw JSON')
  .action((opts) => aiMeetingsUsageCommand(opts));

aiMeetings
  .command('webhook <forwardUrl>')
  .description('Set the forward URL for meeting events. Use --rotate-secret to mint a new signing secret (shown once).')
  .option('--app <appId>', 'Override current app')
  .option('--rotate-secret', 'Generate a new wsec_... signing secret')
  .option('--json', 'Output raw JSON')
  .action((forwardUrl, opts) => aiMeetingsWebhookCommand(forwardUrl, {
    app: opts.app, rotateSecret: opts.rotateSecret, json: opts.json,
  }));

// OAuth
const oauth = program.command('oauth').description('Manage OAuth providers for end-user auth');

oauth
  .command('configure <provider>')
  .description('Configure an OAuth provider (e.g. google, github, apple)')
  .requiredOption('--client-id <id>')
  .requiredOption('--client-secret <secret>')
  .option('--app <appId>', 'Override current app')
  .option('--redirect-uri <uri>', 'Add a redirect URI (repeatable)', (v, prev: string[]) => prev.concat(v), [] as string[])
  .option('--scope <scope>', 'Add a scope (repeatable)', (v, prev: string[]) => prev.concat(v), [] as string[])
  .option('--authorization-url <url>')
  .option('--token-url <url>')
  .option('--userinfo-url <url>')
  .option('--json', 'Output raw JSON')
  .action((provider, opts) => oauthConfigureCommand(provider, opts));

oauth
  .command('list')
  .description('List configured OAuth providers')
  .option('--app <appId>', 'Override current app')
  .option('--json', 'Output raw JSON')
  .action((opts) => oauthListCommand(opts));

oauth
  .command('get <provider>')
  .description('Show config for a provider')
  .option('--app <appId>', 'Override current app')
  .option('--json', 'Output raw JSON')
  .action((provider, opts) => oauthGetCommand(provider, opts));

oauth
  .command('update <provider>')
  .description('Update provider config (any field optional)')
  .option('--app <appId>', 'Override current app')
  .option('--client-id <id>')
  .option('--client-secret <secret>')
  .option('--redirect-uri <uri>', 'Replace redirect URIs', (v, prev: string[]) => prev.concat(v), [] as string[])
  .option('--scope <scope>', 'Replace scopes', (v, prev: string[]) => prev.concat(v), [] as string[])
  .option('--enabled <bool>', 'Enable/disable (true|false)', (v) => v === 'true')
  .option('--json', 'Output raw JSON')
  .action((provider, opts) => oauthUpdateCommand(provider, opts));

oauth
  .command('delete <provider>')
  .description('Delete an OAuth provider configuration')
  .option('--app <appId>', 'Override current app')
  .option('--json', 'Output raw JSON')
  .action((provider, opts) => oauthDeleteCommand(provider, opts));

// Audit
const audit = program.command('audit').description('Query the app\'s audit log');

audit
  .command('query')
  .description('Query audit log entries with optional filters')
  .option('--app <appId>', 'Override current app')
  .option('--category <c>')
  .option('--event-type <e>')
  .option('--action <a>')
  .option('--resource-type <t>')
  .option('--resource-id <id>')
  .option('--actor-id <id>')
  .option('--from <iso>', 'Start of window (ISO date)')
  .option('--to <iso>', 'End of window (ISO date)')
  .option('--limit <n>', 'Max rows', parseInt)
  .option('--offset <n>', 'Pagination offset', parseInt)
  .option('--json', 'Output raw JSON')
  .action((opts) => auditQueryCommand(opts));

// Regions
const regions = program.command('regions').description('Multi-region operations');

regions
  .command('list')
  .description('List supported regions')
  .option('--json', 'Output raw JSON')
  .action((opts) => regionsListCommand(opts));

// App Billing (Stripe Connect — plans/products/subscriptions/orders)
const appBilling = program.command('app-billing').description('Manage app-level Stripe Connect billing (plans/products/subscriptions/orders)');

const abPlans = appBilling.command('plans').description('Subscription plans');
abPlans
  .command('list')
  .option('--app <appId>', 'Override current app')
  .option('--json', 'Output raw JSON')
  .action((opts) => plansListCommand(opts));
abPlans
  .command('create')
  .requiredOption('--name <name>')
  .requiredOption('--price-cents <n>', 'Price in cents', parseInt)
  .requiredOption('--interval <month|year>')
  .option('--description <desc>')
  .option('--app <appId>', 'Override current app')
  .option('--json', 'Output raw JSON')
  .action((opts) => plansCreateCommand(opts));
abPlans
  .command('update <planId>')
  .option('--name <name>')
  .option('--price-cents <n>', 'Price in cents', parseInt)
  .option('--description <desc>')
  .option('--app <appId>', 'Override current app')
  .option('--json', 'Output raw JSON')
  .action((planId, opts) => plansUpdateCommand(planId, opts));

const abProducts = appBilling.command('products').description('One-time products');
abProducts
  .command('list')
  .option('--app <appId>', 'Override current app')
  .option('--json', 'Output raw JSON')
  .action((opts) => productsListCommand(opts));
abProducts
  .command('create')
  .requiredOption('--name <name>')
  .requiredOption('--price-cents <n>', 'Price in cents', parseInt)
  .option('--description <desc>')
  .option('--app <appId>', 'Override current app')
  .option('--json', 'Output raw JSON')
  .action((opts) => productsCreateCommand(opts));
abProducts
  .command('update <productId>')
  .option('--name <name>')
  .option('--price-cents <n>', 'Price in cents', parseInt)
  .option('--description <desc>')
  .option('--app <appId>', 'Override current app')
  .option('--json', 'Output raw JSON')
  .action((productId, opts) => productsUpdateCommand(productId, opts));

appBilling
  .command('subscribe <planId>')
  .option('--app <appId>', 'Override current app')
  .option('--json', 'Output raw JSON')
  .action((planId, opts) => subscribeCommand(planId, opts));

appBilling
  .command('subscription')
  .description('Show the current subscription')
  .option('--app <appId>', 'Override current app')
  .option('--json', 'Output raw JSON')
  .action((opts) => subscriptionCommand(opts));

appBilling
  .command('cancel')
  .description('Cancel the current subscription')
  .option('--app <appId>', 'Override current app')
  .option('--json', 'Output raw JSON')
  .action((opts) => cancelCommand(opts));

appBilling
  .command('purchase <productId>')
  .option('--app <appId>', 'Override current app')
  .option('--json', 'Output raw JSON')
  .action((productId, opts) => purchaseCommand(productId, opts));

const abOrders = appBilling.command('orders').description('Order history');
abOrders
  .command('list')
  .option('--app <appId>', 'Override current app')
  .option('--json', 'Output raw JSON')
  .action((opts) => ordersListCommand(opts));
abOrders
  .command('get <orderId>')
  .option('--app <appId>', 'Override current app')
  .option('--json', 'Output raw JSON')
  .action((orderId, opts) => ordersGetCommand(orderId, opts));

// KV
const kv = program.command('kv').description('Manage app KV store');

kv.command('get <key>')
  .description('Get a value by key')
  .option('--app <id>', 'App ID (uses current app if not specified)')
  .option('--raw', 'Return raw value without JSON decoding')
  .action(kvGetCommand);

kv.command('set <key> <value>')
  .description('Set a value')
  .option('--app <id>', 'App ID (uses current app if not specified)')
  .option('--ttl <ttl>', 'TTL: 30d, 1h, 60s, "null"/"forever" for no expiry')
  .option('--ephemeral', 'Mark as ephemeral (not persisted)')
  .action(kvSetCommand);

kv.command('del <key>')
  .description('Delete a key')
  .option('--app <id>', 'App ID (uses current app if not specified)')
  .action(kvDelCommand);

kv.command('ls')
  .description('List / scan keys')
  .option('--app <id>', 'App ID (uses current app if not specified)')
  .option('--prefix <p>', 'Key prefix filter')
  .option('--limit <n>', 'Maximum keys to return (default 100)')
  .action(kvLsCommand);

kv.command('stats')
  .description('Show KV store statistics')
  .option('--app <id>', 'App ID (uses current app if not specified)')
  .action(kvStatsCommand);

kv.command('flush')
  .description('Flush all keys (requires --confirm)')
  .option('--app <id>', 'App ID (uses current app if not specified)')
  .option('--confirm', 'Required: confirm destructive flush')
  .option('--include-config', 'Also flush expose rules')
  .action(kvFlushCommand);

kv.command('rules')
  .description('List expose rules')
  .option('--app <id>', 'App ID (uses current app if not specified)')
  .action(kvRulesCommand);

kv.command('expose <pattern>')
  .description('Create or update an expose rule')
  .option('--app <id>', 'App ID (uses current app if not specified)')
  .requiredOption('--read <role>', 'Read role (public|authed|owner|deny)')
  .requiredOption('--write <role>', 'Write role (public|authed|owner|deny)')
  .action(kvExposeCommand);

kv.command('unexpose <pattern>')
  .description('Remove an expose rule')
  .option('--app <id>', 'App ID (uses current app if not specified)')
  .action(kvUnexposeCommand);

kv.command('apply <file>')
  .description('Apply KV expose rules from a config file (kv.config.ts)')
  .option('--app <id>', 'App ID (uses current app if not specified)')
  .option('--dry-run', 'Preview changes without applying')
  .option('--yes', 'Skip confirmation prompt')
  .action((file, opts) => kvApplyCommand({ app: opts.app, file, dryRun: opts.dryRun, yes: opts.yes }));

// Substrate
const substrate = program.command('substrate').description('Manage the Substrate AI-agent runtime');

// substrate ledger
const substrateLedger = substrate.command('ledger').description('Browse the substrate action ledger');

substrateLedger
  .command('list')
  .description('List ledger entries')
  .option('--status <status>', 'Filter by status (pending|approved|rejected|executed|failed)')
  .option('--capability <cap>', 'Filter by capability')
  .option('--limit <n>', 'Max rows')
  .option('--before <cursor>', 'Pagination cursor')
  .option('--json', 'Output raw JSON')
  .action((opts) => substrateLedgerCommand(opts));

substrateLedger
  .command('inspect <actionId>')
  .description('Show full details of a ledger entry')
  .option('--json', 'Output raw JSON')
  .action((actionId, opts) => substrateLedgerInspectCommand(actionId, opts));

// substrate propose / approve / reject (top-level convenience)
substrate
  .command('propose <capability>')
  .description('Propose a new substrate action')
  .option('--payload <@path|json>', 'Payload as JSON or @path to JSON file')
  .option('--idempotency-key <key>', 'Client-supplied idempotency key')
  .option('--json', 'Output raw JSON')
  .action((capability, opts) => substrateProposeCommand(capability, opts));

substrate
  .command('approve <actionId>')
  .description('Approve a pending substrate action')
  .option('--json', 'Output raw JSON')
  .action((actionId, opts) => substrateApproveCommand(actionId, opts));

substrate
  .command('reject <actionId>')
  .description('Reject a pending substrate action')
  .option('--reason <text>', 'Rejection reason')
  .option('--json', 'Output raw JSON')
  .action((actionId, opts) => substrateRejectCommand(actionId, opts));

// substrate entities
const substrateEntities = substrate.command('entities').description('Manage substrate entities');

substrateEntities
  .command('list')
  .description('List substrate entities')
  .option('--type <type>', 'Filter by entity type')
  .option('--limit <n>', 'Max rows')
  .option('--json', 'Output raw JSON')
  .action((opts) => substrateEntitiesListCommand(opts));

substrateEntities
  .command('get <id>')
  .description('Get a substrate entity by ID')
  .option('--json', 'Output raw JSON')
  .action((id, opts) => substrateEntitiesGetCommand(id, opts));

substrateEntities
  .command('update <id>')
  .description('Patch a substrate entity')
  .option('--patch <@path|json>', 'Patch as JSON or @path to JSON file')
  .option('--json', 'Output raw JSON')
  .action((id, opts) => substrateEntitiesUpdateCommand(id, opts));

// substrate artifacts
const substrateArtifacts = substrate.command('artifacts').description('Manage substrate source artifacts (meeting transcripts, email threads, etc.)');

substrateArtifacts
  .command('list')
  .description('List source artifacts (optionally filter or full-text search)')
  .option('--kind <kind>', 'Filter by kind (meeting_notes, email_thread, call_recording, document, …)')
  .option('--q <query>', 'Full-text search over title, summary, content')
  .option('--limit <n>', 'Max rows')
  .option('--json', 'Output raw JSON')
  .action((opts) => substrateArtifactsListCommand(opts));

substrateArtifacts
  .command('get <id>')
  .description('Get a source artifact by id (returns full content)')
  .option('--json', 'Output raw JSON')
  .action((id, opts) => substrateArtifactsGetCommand(id, opts));

// substrate memory
substrate
  .command('memory <query>')
  .description('Semantic search over substrate memory (decisions, commitments, learnings, source artifacts)')
  .option('--limit <n>', 'Max results')
  .option('--json', 'Output raw JSON')
  .action((query, opts) => substrateMemoryCommand(query, opts));

// substrate outbox
const substrateOutbox = substrate.command('outbox').description('Manage the substrate outbox queue');

substrateOutbox
  .command('list')
  .description('List outbox messages')
  .option('--state <state>', 'Filter by state (pending|sent|failed|cancelled)')
  .option('--json', 'Output raw JSON')
  .action((opts) => substrateOutboxListCommand(opts));

substrateOutbox
  .command('cancel <id>')
  .description('Cancel a pending outbox message')
  .option('--json', 'Output raw JSON')
  .action((id, opts) => substrateOutboxCancelCommand(id, opts));

substrateOutbox
  .command('retry <id>')
  .description('Retry a failed outbox message')
  .option('--json', 'Output raw JSON')
  .action((id, opts) => substrateOutboxRetryCommand(id, opts));

// substrate rules
const substrateRules = substrate.command('rules').description('Manage substrate automation rules');

substrateRules
  .command('list')
  .description('List automation rules')
  .option('--enabled', 'Show only enabled rules')
  .option('--json', 'Output raw JSON')
  .action((opts) => substrateRulesListCommand(opts));

substrateRules
  .command('get <id>')
  .description('Get a rule by ID')
  .option('--json', 'Output raw JSON')
  .action((id, opts) => substrateRulesGetCommand(id, opts));

substrateRules
  .command('create')
  .description('Create a new automation rule')
  .option('--file <@path>', 'Rule definition from JSON file')
  .option('--json', 'Output raw JSON')
  .action((opts) => substrateRulesCreateCommand(opts));

substrateRules
  .command('update <id>')
  .description('Update an existing automation rule')
  .option('--file <@path>', 'Updated rule definition from JSON file')
  .option('--json', 'Output raw JSON')
  .action((id, opts) => substrateRulesUpdateCommand(id, opts));

substrateRules
  .command('delete <id>')
  .description('Delete an automation rule')
  .option('--json', 'Output raw JSON')
  .action((id, opts) => substrateRulesDeleteCommand(id, opts));

substrateRules
  .command('enable <id>')
  .description('Enable an automation rule')
  .option('--json', 'Output raw JSON')
  .action((id, opts) => substrateRulesEnableCommand(id, opts));

substrateRules
  .command('disable <id>')
  .description('Disable an automation rule')
  .option('--json', 'Output raw JSON')
  .action((id, opts) => substrateRulesDisableCommand(id, opts));

substrateRules
  .command('firings <id>')
  .description('List firings for an automation rule')
  .option('--limit <n>', 'Max rows')
  .option('--json', 'Output raw JSON')
  .action((id, opts) => substrateRulesFiringsCommand(id, opts));

// substrate snapshots
substrate
  .command('snapshots')
  .description('List substrate snapshots')
  .option('--days <n>', 'Look-back window in days')
  .option('--json', 'Output raw JSON')
  .action((opts) => substrateSnapshotsCommand(opts));

// substrate settings
const substrateSettings = substrate.command('settings').description('Manage substrate settings');

substrateSettings
  .command('show')
  .description('Show current substrate settings')
  .option('--json', 'Output raw JSON')
  .action((opts) => substrateSettingsShowCommand(opts));

substrateSettings
  .command('yolo <state>')
  .description('Enable or disable YOLO mode (auto-approve all actions)')
  .option('--json', 'Output raw JSON')
  .action((state, opts) => substrateSettingsYoloCommand(state, opts));

// Repo
const repo = program.command('repo').description('Push, pull, and inspect this app\'s repository snapshot');

repo
  .command('init <app-id>')
  .description('Bind this folder to an app — writes .butterbase/config.json and seeds .butterbaseignore')
  .option('--force', 'Overwrite an existing .butterbase/config.json')
  .option('--no-ignore', 'Skip seeding .butterbaseignore')
  .action((appId, opts) => repoInitCommand(appId, opts));

repo
  .command('push')
  .description('Walk this folder, hash files, upload missing blobs, commit a new snapshot')
  .option('--app <app-id>', 'Override the bound app')
  .option('--message <text>', 'Attach a push message to the snapshot')
  .option('--dry-run', 'Print the manifest summary without contacting the API')
  .option('--json', 'Output raw JSON on success')
  .action((opts) => repoPushCommand(opts));

repo
  .command('pull')
  .description('Reconcile this folder against the latest remote snapshot')
  .option('--app <app-id>', 'Override the bound app')
  .option('--force', 'Drop local changes that conflict with remote deletes')
  .option('--json', 'Output raw JSON on success')
  .action((opts) => repoPullCommand(opts));

repo
  .command('status')
  .description('git status-style summary of the working tree vs the pinned snapshot')
  .option('--app <app-id>', 'Override the bound app')
  .option('--json', 'Output raw JSON')
  .action((opts) => repoStatusCommand(opts));

repo
  .command('log')
  .description('List snapshot history (newest first)')
  .option('--app <app-id>', 'Override the bound app')
  .option('--json', 'Output raw JSON')
  .action((opts) => repoLogCommand(opts));

repo
  .command('wipe')
  .description('Delete the entire repo (irreversible)')
  .option('--app <app-id>', 'Override the bound app')
  .option('-y, --yes', 'Skip the name-confirmation prompt')
  .action((opts) => repoWipeCommand(opts));

// Clone
program
  .command('clone [source-app-id] [target-dir]')
  .description('Clone a public app into a new owned app + local folder')
  .option('--name <text>', 'Name for the new app (defaults to "Clone of <source>")')
  .option('--region <region>', 'Region for the new app (defaults to source\'s region)')
  .option('--retry <job_id>', 'Resume a previously-failed clone job by id (mutually exclusive with source-app-id)')
  .option('--json', 'Output raw JSON on success')
  .action((sourceAppId, targetDir, opts) => {
    if (opts.retry && sourceAppId) {
      console.error('Error: --retry and <source-app-id> are mutually exclusive. Provide one or the other.');
      process.exit(1);
      return;
    }
    if (opts.retry) {
      return cloneRetryCommand(opts.retry, targetDir, opts);
    }
    if (!sourceAppId) {
      console.error('Error: <source-app-id> is required unless --retry is provided.');
      process.exit(1);
      return;
    }
    return cloneCommand(sourceAppId, targetDir, opts);
  });

// Templates (browse public templates)
program
  .command('templates')
  .description('Browse public app templates')
  .option('--q <text>', 'Search query')
  .option('--sort <recent|popular>', 'Sort order (recent or popular)')
  .option('--region <slug>', 'Filter by region')
  .option('--limit <n>', 'Max results', parseInt)
  .option('--offset <n>', 'Pagination offset', parseInt)
  .option('--json', 'Output raw JSON')
  .action((opts) => templatesCommand(opts));

// Visibility (top-level convenience wrapper for PATCH /config/visibility)
program
  .command('visibility <mode>')
  .description('Set app visibility: public | private')
  .option('--app <app-id>', 'Override current app')
  .option('--listed', 'List in /v1/templates (public only)')
  .option('--unlisted', 'Hide from /v1/templates (public only)')
  .option('--json', 'Output raw JSON')
  .action((mode, opts) => visibilityCommand(mode as 'public' | 'private', opts));

// Agents
const agents = program.command('agents').description('Manage agents');

agents
  .command('list <app>')
  .description('List agents for an app')
  .action(agentsListCommand);

agents
  .command('get <app> <name>')
  .description('Get a specific agent')
  .action(agentsGetCommand);

agents
  .command('create <app>')
  .description('Create an agent from a spec file')
  .requiredOption('--file <path>', 'Path to agent spec JSON file')
  .action(agentsCreateCommand);

agents
  .command('update <app> <name>')
  .description('Update an agent from a spec file')
  .requiredOption('--file <path>', 'Path to agent spec JSON file')
  .action(agentsUpdateCommand);

agents
  .command('delete <app> <name>')
  .description('Delete an agent')
  .option('-y, --yes', 'Skip confirmation prompt')
  .action(agentsDeleteCommand);

// Top-level error handlers for unhandled exceptions / rejections
process.on('uncaughtException', (err) => {
  console.error(renderError(err));
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.error(renderError(err));
  process.exit(1);
});

// Parse arguments
program.parse();
