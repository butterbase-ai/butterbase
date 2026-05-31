// submodules/butterbase-oss/packages/cli/src/commands/repo.ts
import chalk from 'chalk';
import ora from 'ora';
import prompts from 'prompts';
import fs from 'fs-extra';
import path from 'path';
import { loadProjectConfig, saveProjectConfig, getBoundAppId, setPinnedSnapshotId } from '../lib/config.js';
import { repoApi } from '../lib/repo-api.js';

async function requireBoundApp(opts: { app?: string }): Promise<string> {
  if (opts.app) return opts.app;
  const bound = await getBoundAppId();
  if (!bound) {
    console.log(chalk.red('✗ no app bound to this folder. Run `butterbase repo init <app_id>` first.'));
    process.exit(1);
  }
  return bound!;
}

export async function repoInitCommand(
  appId: string,
  opts: { force?: boolean; noIgnore?: boolean }
) {
  const projectPath = path.resolve(process.cwd(), '.butterbase/config.json');
  const existing = await loadProjectConfig();
  if (existing && !opts.force) {
    console.log(chalk.red(`✗ .butterbase/config.json already exists (currentApp=${(existing as any).currentApp ?? '?'}). Use --force to overwrite.`));
    process.exit(1);
  }
  await saveProjectConfig({ ...(existing ?? {}), currentApp: appId });

  // Seed a .butterbaseignore if it doesn't exist. Users can delete or edit; we just give
  // them a starting point.
  if (!opts.noIgnore) {
    const ignorePath = path.join(process.cwd(), '.butterbaseignore');
    if (!(await fs.pathExists(ignorePath))) {
      await fs.writeFile(ignorePath, [
        '# Patterns here ADD to the defaults (.git/, node_modules/, dist/, .next/, .turbo/, .DS_Store, .butterbase/).',
        '# .gitignore patterns also apply. Use `!path` to un-ignore.',
        '',
        '# Examples:',
        '# secrets/',
        '# *.local',
        '',
      ].join('\n'), 'utf8');
    }
  }

  console.log(chalk.green(`✓ bound ${path.relative(process.cwd(), projectPath)} → app ${appId}`));
}

export async function repoWipeCommand(opts: { app?: string; yes?: boolean }) {
  const appId = await requireBoundApp(opts);
  if (!opts.yes) {
    const { ok } = await prompts({
      type: 'text',
      name: 'ok',
      message: `Type the app id "${appId}" to wipe its repo (cannot be undone)`,
    });
    if (ok !== appId) {
      console.log(chalk.yellow('aborted'));
      return;
    }
  }
  const spinner = ora('Wiping repo…').start();
  try {
    const res = await repoApi.wipe(appId);
    spinner.succeed(`Repo wiped for ${res.app_id}`);
    await setPinnedSnapshotId(null);
  } catch (e) {
    spinner.fail((e as Error).message);
    process.exit(1);
  }
}

export async function repoLogCommand(opts: { app?: string; json?: boolean }) {
  const appId = await requireBoundApp(opts);
  const { snapshots } = await repoApi.listSnapshots(appId);
  if (opts.json) {
    console.log(JSON.stringify({ snapshots }, null, 2));
    return;
  }
  if (snapshots.length === 0) {
    console.log(chalk.gray('(no snapshots yet — run `butterbase repo push`)'));
    return;
  }
  for (const s of snapshots) {
    console.log(`${chalk.cyan(s.snapshot_id.slice(0, 12))}  ${s.created_at}`);
  }
}
