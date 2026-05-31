// submodules/butterbase-oss/packages/cli/src/commands/repo.ts
import chalk from 'chalk';
import ora from 'ora';
import prompts from 'prompts';
import fs from 'fs-extra';
import path from 'path';
import { createHash } from 'crypto';
import { loadProjectConfig, saveProjectConfig, getBoundAppId, setPinnedSnapshotId, getPinnedSnapshotId } from '../lib/config.js';
import { repoApi, uploadBlob, downloadBlob, type FileEntry } from '../lib/repo-api.js';
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

  // Lookup table absPath by sha256 — picking any one path per sha is fine since
  // content-addressed blobs are by sha, not by path.
  const absBySha = new Map<string, string>();
  for (let i = 0; i < walked.length; i++) absBySha.set(files[i].sha256, walked[i].absPath);

  // Upload missing blobs serially. (Parallelization can come later — see Task 7 notes.)
  const uploadMissing = async (missing: { sha256: string; uploadUrl: string }[], label: string) => {
    for (let i = 0; i < missing.length; i++) {
      const m = missing[i];
      const abs = absBySha.get(m.sha256);
      if (!abs) {
        console.log(chalk.red(`✗ server asked for blob ${m.sha256} that isn't in our manifest`));
        process.exit(1);
      }
      const upSpin = ora(`${label} ${i + 1}/${missing.length} ${m.sha256.slice(0, 12)}…`).start();
      try {
        const buf = await fs.readFile(abs!);
        await uploadBlob(m.uploadUrl, buf as any);
        upSpin.succeed();
      } catch (e) {
        upSpin.fail((e as Error).message);
        process.exit(1);
      }
    }
  };

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

  await uploadMissing(prep.missing_blobs, 'Uploading');

  const requestBody = opts.message === undefined ? { files } : { files, message: opts.message };

  const commitSpin = ora('Committing snapshot…').start();
  let commitRes;
  try {
    commitRes = await repoApi.commit(appId, requestBody);
  } catch (e) {
    const status = (e as any)?.status;
    const details = (e as any)?.details as { missing_shas?: string[]; size_mismatches?: { sha256: string }[] } | undefined;
    const recoverable = status === 409 && (details?.missing_shas?.length || details?.size_mismatches?.length);
    if (!recoverable) {
      commitSpin.fail((e as Error).message);
      process.exit(1);
      return;
    }
    // Retry path: re-prepare to get fresh presigned URLs for whatever the server still wants.
    const stillMissing = new Set<string>([
      ...(details?.missing_shas ?? []),
      ...(details?.size_mismatches?.map(s => s.sha256) ?? []),
    ]);
    commitSpin.warn(`Commit returned 409 for ${stillMissing.size} blob(s). Re-uploading and retrying once…`);
    let reprep;
    try {
      reprep = await repoApi.prepare(appId, requestBody);
    } catch (e2) {
      console.log(chalk.red(`✗ re-prepare failed: ${(e2 as Error).message}`));
      process.exit(1);
      return;
    }
    await uploadMissing(reprep.missing_blobs, 'Re-uploading');
    try {
      commitRes = await repoApi.commit(appId, requestBody);
    } catch (e2) {
      console.log(chalk.red(`✗ commit still failing after retry: ${(e2 as Error).message}`));
      process.exit(1);
      return;
    }
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

async function sha256File(absPath: string): Promise<string | null> {
  try {
    const buf = await fs.readFile(absPath);
    return createHash('sha256').update(buf).digest('hex');
  } catch (e: any) {
    if (e?.code === 'ENOENT') return null;
    throw e;
  }
}

export async function repoPullCommand(opts: { app?: string; force?: boolean; json?: boolean }) {
  const appId = await requireBoundApp(opts);
  const root = process.cwd();

  const pinned = await getPinnedSnapshotId();

  const latestSpin = ora('Fetching latest snapshot…').start();
  let latest;
  try {
    latest = await repoApi.getLatest(appId);
  } catch (e) {
    latestSpin.fail((e as Error).message);
    process.exit(1);
    return;
  }
  latestSpin.succeed(`Remote latest: ${latest.snapshot_id.slice(0, 12)}`);

  if (pinned === latest.snapshot_id) {
    console.log(chalk.gray('Already up to date.'));
    return;
  }

  // Build the set of paths in the new manifest for quick lookup, plus path → expected sha.
  const wantedSha = new Map<string, string>();
  for (const f of latest.manifest.files) wantedSha.set(f.path, f.sha256);

  // Fetch the pinned manifest so we can reason about "files locally but not in latest".
  // If pinned was pruned (404) or pinned is null, we can only safely delete on --force.
  let pinnedManifestFiles: { path: string; sha256: string }[] | null = null;
  if (pinned) {
    try {
      const p = await repoApi.getSnapshot(appId, pinned);
      pinnedManifestFiles = p.manifest.files;
    } catch {
      console.log(chalk.yellow(`⚠ pinned snapshot ${pinned.slice(0,12)} no longer on server (pruned). Local untracked deletions will require --force.`));
    }
  }
  const pinnedSha = new Map<string, string>();
  if (pinnedManifestFiles) for (const f of pinnedManifestFiles) pinnedSha.set(f.path, f.sha256);

  // 1. Decide downloads (latest has it; local sha doesn't match).
  const toDownload: { path: string; sha256: string }[] = [];
  for (const f of latest.manifest.files) {
    const localSha = await sha256File(path.join(root, f.path));
    if (localSha !== f.sha256) toDownload.push(f);
  }

  // 2. Decide deletions (local has it; latest doesn't).
  const ig = await loadIgnoreRules(root);
  const localFiles: string[] = [];
  for await (const f of walkRepo(root, ig)) localFiles.push(f.relPath);
  const toDelete: string[] = [];
  const conflicts: string[] = [];
  for (const lp of localFiles) {
    if (wantedSha.has(lp)) continue;
    const localSha = await sha256File(path.join(root, lp));
    if (localSha === null) continue;
    const expectedPinned = pinnedSha.get(lp);
    if (expectedPinned === undefined || expectedPinned === localSha) {
      // Either we never knew about it (pinned doesn't include it — shouldn't happen for tracked files,
      // but be permissive) or the user hasn't touched it since the pinned snapshot.
      toDelete.push(lp);
    } else {
      conflicts.push(lp);
    }
  }

  if (conflicts.length > 0 && !opts.force) {
    console.log(chalk.red(`✗ ${conflicts.length} local file(s) deleted on the remote but modified locally:`));
    for (const p of conflicts) console.log(`    ${p}`);
    console.log(chalk.gray('Re-run with --force to drop local changes for those files.'));
    process.exit(1);
  }
  // With --force, the conflicts also get deleted.
  if (opts.force) for (const p of conflicts) toDelete.push(p);

  if (toDownload.length === 0 && toDelete.length === 0) {
    // No file changes — just bump the pin and done.
    await setPinnedSnapshotId(latest.snapshot_id);
    console.log(chalk.gray('Nothing to change locally; pin updated.'));
    return;
  }

  // Apply downloads.
  for (let i = 0; i < toDownload.length; i++) {
    const f = toDownload[i];
    const dlSpin = ora(`Fetching ${i + 1}/${toDownload.length} ${f.path}`).start();
    try {
      const url = await repoApi.getBlobUrl(appId, f.sha256);
      const buf = await downloadBlob(url.downloadUrl);
      await fs.ensureDir(path.dirname(path.join(root, f.path)));
      await fs.writeFile(path.join(root, f.path), buf);
      dlSpin.succeed();
    } catch (e) {
      dlSpin.fail((e as Error).message);
      process.exit(1);
    }
  }

  // Apply deletes.
  for (const p of toDelete) {
    await fs.remove(path.join(root, p));
    console.log(chalk.gray(`  deleted ${p}`));
  }

  await setPinnedSnapshotId(latest.snapshot_id);
  if (opts.json) {
    console.log(JSON.stringify({
      snapshot_id: latest.snapshot_id,
      downloaded: toDownload.map(f => f.path),
      deleted: toDelete,
    }, null, 2));
  } else {
    console.log(chalk.green(`✓ pulled snapshot ${latest.snapshot_id.slice(0, 12)} — ${toDownload.length} downloaded, ${toDelete.length} deleted`));
  }
}

type RepoStatusFile = { path: string; state: 'unchanged' | 'modified' | 'untracked' | 'deleted' | 'new' };

export async function repoStatusCommand(opts: { app?: string; json?: boolean }) {
  const appId = await requireBoundApp(opts);
  const root = process.cwd();
  const pinned = await getPinnedSnapshotId();

  let remoteLatest: string | null = null;
  let remoteFiles: Map<string, string> | null = null;  // path → sha256
  try {
    const latest = await repoApi.getLatest(appId);
    remoteLatest = latest.snapshot_id;
    remoteFiles = new Map(latest.manifest.files.map(f => [f.path, f.sha256]));
  } catch (e: any) {
    // 404 = no snapshots yet. Anything else: surface.
    const msg = String((e as Error).message ?? '');
    if (!msg.includes('404') && !/not found/i.test(msg)) throw e;
  }

  let pinnedFiles: Map<string, string> | null = null;
  if (pinned) {
    try {
      const p = await repoApi.getSnapshot(appId, pinned);
      pinnedFiles = new Map(p.manifest.files.map(f => [f.path, f.sha256]));
    } catch { /* pruned */ }
  }

  const ig = await loadIgnoreRules(root);
  const local: { path: string; sha256: string }[] = [];
  for await (const f of walkRepo(root, ig)) {
    const buf = await fs.readFile(f.absPath);
    local.push({ path: f.relPath, sha256: createHash('sha256').update(buf).digest('hex') });
  }
  const localBy = new Map(local.map(f => [f.path, f.sha256]));

  // Diff against pinned (or remote if no pin).
  const baseline = pinnedFiles ?? remoteFiles ?? new Map<string, string>();
  const files: RepoStatusFile[] = [];
  for (const f of local) {
    const base = baseline.get(f.path);
    if (base === undefined) {
      files.push({ path: f.path, state: 'untracked' });
    } else if (base !== f.sha256) {
      files.push({ path: f.path, state: 'modified' });
    } else {
      files.push({ path: f.path, state: 'unchanged' });
    }
  }
  for (const [p] of baseline) {
    if (!localBy.has(p)) files.push({ path: p, state: 'deleted' });
  }
  // Anything in remote that isn't in pinned or local → new since pin.
  if (remoteFiles && pinnedFiles) {
    for (const [p] of remoteFiles) {
      if (!pinnedFiles.has(p) && !localBy.has(p)) files.push({ path: p, state: 'new' });
    }
  }

  if (opts.json) {
    console.log(JSON.stringify({
      app_id: appId,
      pinned_snapshot_id: pinned,
      remote_latest_snapshot_id: remoteLatest,
      files: files.filter(f => f.state !== 'unchanged'),
    }, null, 2));
    return;
  }

  console.log(`${chalk.bold('app')}      ${appId}`);
  console.log(`${chalk.bold('pinned')}   ${pinned ? pinned.slice(0, 12) : chalk.gray('(none)')}`);
  console.log(`${chalk.bold('remote')}   ${remoteLatest ? remoteLatest.slice(0, 12) : chalk.gray('(no snapshots)')}`);
  if (pinned && remoteLatest && pinned !== remoteLatest) {
    console.log(chalk.yellow('⚠ pin is behind remote — run `butterbase repo pull`'));
  }
  console.log();
  let printed = 0;
  for (const f of files) {
    if (f.state === 'unchanged') continue;
    printed++;
    const tag =
      f.state === 'modified' ? chalk.yellow('M') :
      f.state === 'untracked' ? chalk.cyan('?') :
      f.state === 'deleted' ? chalk.red('D') :
      chalk.green('N');
    console.log(`  ${tag} ${f.path}`);
  }
  if (printed === 0) console.log(chalk.green('working tree clean'));
}
