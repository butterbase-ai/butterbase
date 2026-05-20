import chalk from 'chalk';
import ora from 'ora';
import {
  getAppConfig, updateCors, updateJwt, updateStorageConfig, updateAccessMode, secureApp,
} from '../lib/api-client.js';
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

export async function appConfigGetCommand(options: { app?: string; json?: boolean }) {
  const appId = await requireAppId(options.app);
  try {
    const r = await getAppConfig(appId);
    console.log(options.json ? JSON.stringify(r, null, 2) : r);
  } catch (e) {
    console.error(chalk.red((e as Error).message));
    process.exit(1);
  }
}

export async function appCorsCommand(options: {
  app?: string;
  allowedOrigin?: string[]; allowedMethod?: string[]; allowedHeader?: string[]; allowCredentials?: boolean;
  json?: boolean;
}) {
  const appId = await requireAppId(options.app);
  const body: Record<string, unknown> = {};
  if (options.allowedOrigin) body.allowedOrigins = options.allowedOrigin;
  if (options.allowedMethod) body.allowedMethods = options.allowedMethod;
  if (options.allowedHeader) body.allowedHeaders = options.allowedHeader;
  if (options.allowCredentials !== undefined) body.allowCredentials = options.allowCredentials;
  if (Object.keys(body).length === 0) {
    console.log(chalk.yellow('Nothing to update — pass at least one of --allowed-origin, --allowed-method, --allowed-header, --allow-credentials.'));
    process.exit(1);
  }
  const spinner = ora('Updating CORS...').start();
  try {
    const r = await updateCors(appId, body);
    spinner.succeed('CORS updated');
    if (options.json) console.log(JSON.stringify(r, null, 2));
  } catch (e) {
    spinner.fail('CORS update failed');
    console.error(chalk.red((e as Error).message));
    process.exit(1);
  }
}

export async function appJwtCommand(options: {
  app?: string; accessTokenTtl?: string; refreshTokenTtlDays?: number; json?: boolean;
}) {
  const appId = await requireAppId(options.app);
  const body: Record<string, unknown> = {};
  if (options.accessTokenTtl) body.accessTokenTtl = options.accessTokenTtl;
  if (options.refreshTokenTtlDays !== undefined) body.refreshTokenTtlDays = options.refreshTokenTtlDays;
  if (Object.keys(body).length === 0) {
    console.log(chalk.yellow('Nothing to update — pass --access-token-ttl or --refresh-token-ttl-days.'));
    process.exit(1);
  }
  const spinner = ora('Updating JWT config...').start();
  try {
    const r = await updateJwt(appId, body);
    spinner.succeed('JWT config updated');
    if (options.json) console.log(JSON.stringify(r, null, 2));
  } catch (e) {
    spinner.fail('JWT update failed');
    console.error(chalk.red((e as Error).message));
    process.exit(1);
  }
}

export async function appStorageCommand(options: {
  app?: string; publicRead?: boolean; maxFileSizeMb?: number; allowedContentType?: string[]; json?: boolean;
}) {
  const appId = await requireAppId(options.app);
  const body: Record<string, unknown> = {};
  if (options.publicRead !== undefined) body.publicReadEnabled = options.publicRead;
  if (options.maxFileSizeMb !== undefined) body.maxFileSizeMb = options.maxFileSizeMb;
  if (options.allowedContentType) body.allowedContentTypes = options.allowedContentType;
  if (Object.keys(body).length === 0) {
    console.log(chalk.yellow('Nothing to update — pass --public-read, --max-file-size-mb, or --allowed-content-type.'));
    process.exit(1);
  }
  const spinner = ora('Updating storage config...').start();
  try {
    const r = await updateStorageConfig(appId, body as { publicReadEnabled?: boolean });
    spinner.succeed('Storage config updated');
    if (options.json) console.log(JSON.stringify(r, null, 2));
  } catch (e) {
    spinner.fail('Storage update failed');
    console.error(chalk.red((e as Error).message));
    process.exit(1);
  }
}

export async function appAccessModeCommand(mode: string, options: { app?: string; json?: boolean }) {
  if (mode !== 'public' && mode !== 'authenticated') {
    console.log(chalk.red(`Invalid mode '${mode}'. Must be 'public' or 'authenticated'.`));
    process.exit(1);
  }
  const appId = await requireAppId(options.app);
  const spinner = ora(`Setting access-mode to ${mode}...`).start();
  try {
    const r = await updateAccessMode(appId, mode);
    spinner.succeed(`Access mode = ${mode}`);
    if (options.json) console.log(JSON.stringify(r, null, 2));
  } catch (e) {
    spinner.fail('Access-mode update failed');
    console.error(chalk.red((e as Error).message));
    process.exit(1);
  }
}

export async function appSecureCommand(options: {
  app?: string; table?: string[]; userColumn?: string; accessMode?: string; json?: boolean;
}) {
  const appId = await requireAppId(options.app);
  const body: Record<string, unknown> = {};
  // The backend expects tables: [{ table_name, user_column, public_read_column? }]
  // For simplicity, the CLI accepts repeatable --table <name> and a single --user-column applied to each.
  if (options.table && options.table.length > 0) {
    const userColumn = options.userColumn ?? 'user_id';
    body.tables = options.table.map((t) => ({ table_name: t, user_column: userColumn }));
  }
  if (options.accessMode) {
    if (options.accessMode !== 'public' && options.accessMode !== 'authenticated') {
      console.log(chalk.red(`Invalid --access-mode '${options.accessMode}'`));
      process.exit(1);
    }
  }
  const spinner = ora('Securing app...').start();
  try {
    const r = await secureApp(appId, body);
    spinner.succeed('App secured');
    if (options.json) console.log(JSON.stringify(r, null, 2));
  } catch (e) {
    spinner.fail('Secure failed');
    console.error(chalk.red((e as Error).message));
    process.exit(1);
  }
}
