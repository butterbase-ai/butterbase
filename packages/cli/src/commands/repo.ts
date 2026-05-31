// submodules/butterbase-oss/packages/cli/src/commands/repo.ts
import chalk from 'chalk';
import ora from 'ora';
import prompts from 'prompts';
import fs from 'fs-extra';
import path from 'path';
import { loadProjectConfig, saveProjectConfig, getBoundAppId, setPinnedSnapshotId } from '../lib/config.js';
import { repoApi, uploadBlob, type FileEntry } from '../lib/repo-api.js';
import { loadIgnoreRules } from '../lib/repo-ignore.js';
import { walkRepo, type WalkedFile } from '../lib/repo-walk.js';
import { buildManifest } from '../lib/repo-manifest.js';

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

export async function repoPushCommand(opts: {
  app?: string;
  message?: string;
  dryRun?: boolean;
  json?: boolean;
}) {
  const appId = await requireBoundApp(opts);
  const root = process.cwd();

  const walkSpin = ora('Walking project tree…').start();
  const ig = await loadIgnoreRules(root);
  const walked: WalkedFile[] = [];
  for await (const f of walkRepo(root, ig)) walked.push(f);
  walkSpin.succeed(`Walked ${walked.length} files`);

  if (walked.length === 0) {
    console.log(chalk.yellow('✗ nothing to push — every file is ignored or the folder is empty'));
    process.exit(1);
  }

  const hashSpin = ora('Hashing files…').start();
  let files: FileEntry[];
  try {
    files = await buildManifest(walked);
  } catch (e) {
    hashSpin.fail((e as Error).message);
    process.exit(1);
    return;
  }
  const totalBytes = files.reduce((n, f) => n + f.size, 0);
  hashSpin.succeed(`Hashed ${files.length} files (${formatBytes(totalBytes)})`);

  if (opts.dryRun) {
    if (opts.json) {
      console.log(JSON.stringify({ files, total_bytes: totalBytes, file_count: files.length }, null, 2));
    } else {
      for (const f of files) console.log(`${f.sha256.slice(0, 12)}  ${formatBytes(f.size).padStart(8)}  ${f.path}`);
      console.log(chalk.gray(`-- ${files.length} files, ${formatBytes(totalBytes)} total`));
    }
    return;
  }

  const prepSpin = ora('Preparing snapshot…').start();
  let prep;
  try {
    prep = await repoApi.prepare(appId, opts.message === undefined ? { files } : { files, message: opts.message });
  } catch (e) {
    prepSpin.fail((e as Error).message);
    process.exit(1);
    return;
  }
  prepSpin.succeed(`Snapshot id ${prep.snapshot_id.slice(0, 12)} — ${prep.missing_blobs.length} new blobs to upload`);

  // Upload missing blobs serially. (Parallelization can come later — see Task 7 notes.)
  // Lookup table absPath by sha256 — picking any one path per sha is fine since
  // content-addressed blobs are by sha, not by path.
  const absBySha = new Map<string, string>();
  for (let i = 0; i < walked.length; i++) absBySha.set(files[i].sha256, walked[i].absPath);

  for (let i = 0; i < prep.missing_blobs.length; i++) {
    const m = prep.missing_blobs[i];
    const abs = absBySha.get(m.sha256);
    if (!abs) {
      console.log(chalk.red(`✗ server asked for blob ${m.sha256} that isn't in our manifest`));
      process.exit(1);
    }
    const upSpin = ora(`Uploading ${i + 1}/${prep.missing_blobs.length} ${m.sha256.slice(0, 12)}…`).start();
    try {
      const buf = await fs.readFile(abs!);
      await uploadBlob(m.uploadUrl, buf as any);
      upSpin.succeed();
    } catch (e) {
      upSpin.fail((e as Error).message);
      process.exit(1);
    }
  }

  const commitSpin = ora('Committing snapshot…').start();
  let commitRes;
  try {
    commitRes = await repoApi.commit(appId, opts.message === undefined ? { files } : { files, message: opts.message });
  } catch (e) {
    commitSpin.fail((e as Error).message);
    process.exit(1);
    return;
  }
  commitSpin.succeed(`Committed ${commitRes.snapshot_id.slice(0, 12)} (${commitRes.file_count} files, ${formatBytes(commitRes.total_bytes)})`);

  await setPinnedSnapshotId(commitRes.snapshot_id);

  if (opts.json) {
    console.log(JSON.stringify({ snapshot_id: commitRes.snapshot_id, total_bytes: commitRes.total_bytes, file_count: commitRes.file_count }, null, 2));
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
