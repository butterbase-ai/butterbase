import chalk from 'chalk';
import { exec } from 'node:child_process';
import { getAppConfig, listDeployments } from '../lib/api-client.js';
import { getCurrentAppId, getMergedConfig } from '../lib/config.js';

async function requireAppId(appId?: string): Promise<string> {
  if (appId) return appId;
  const currentAppId = await getCurrentAppId();
  if (!currentAppId) {
    console.log(chalk.red('No app specified and no current app set'));
    console.log(chalk.gray('Use: butterbase apps use <app-id>'));
    process.exit(1);
  }
  return currentAppId;
}

function openUrl(url: string) {
  const cmd = process.platform === 'win32' ? 'start' :
              process.platform === 'darwin' ? 'open' : 'xdg-open';
  exec(`${cmd} ${url}`);
}

export async function openCommand(options: { app?: string; api?: boolean }) {
  const appId = await requireAppId(options.app);

  if (options.api) {
    const config = await getMergedConfig();
    const url = `${config.endpoint}/v1/${appId}`;
    console.log(chalk.gray(`Opening ${url}`));
    openUrl(url);
    return;
  }

  try {
    const result = await listDeployments(appId);
    const deployments = (result as any).deployments || [];
    const ready = deployments.find((d: any) => d.status === 'READY');

    if (!ready?.url) {
      console.log(chalk.yellow('No active deployment found'));
      console.log(chalk.gray('Deploy your frontend with: butterbase deploy'));
      return;
    }

    console.log(chalk.gray(`Opening ${ready.url}`));
    openUrl(ready.url);
  } catch (error) {
    console.error(chalk.red((error as Error).message));
    process.exit(1);
  }
}
