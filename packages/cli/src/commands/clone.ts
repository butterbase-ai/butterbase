import chalk from 'chalk';
import ora from 'ora';
import fs from 'fs-extra';
import path from 'path';
import { cloneApi } from '../lib/repo-api.js';
import { repoInitCommand, repoPullCommand } from './repo.js';

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

export async function cloneCommand(
  sourceAppId: string,
  targetDir: string | undefined,
  opts: { name?: string; region?: string; json?: boolean },
) {
  const createSpin = ora(`Creating clone job for ${sourceAppId}…`).start();
  let job;
  try {
    const body: { name?: string; region?: string } = {};
    if (opts.name) body.name = opts.name;
    if (opts.region) body.region = opts.region;
    job = await cloneApi.create(sourceAppId, body);
  } catch (e) {
    createSpin.fail((e as Error).message);
    process.exit(1);
    return;
  }
  createSpin.succeed(`Clone job ${job.job_id} pending`);

  // Poll
  const pollSpin = ora('Waiting for clone to complete…').start();
  const start = Date.now();
  let final;
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    let cur;
    try {
      cur = await cloneApi.get(job.job_id);
    } catch (e) {
      pollSpin.fail((e as Error).message);
      process.exit(1);
      return;
    }
    if (cur.status === 'completed' || cur.status === 'failed') {
      final = cur;
      break;
    }
    pollSpin.text = `Waiting for clone to complete… (${cur.status})`;
  }
  if (!final) {
    pollSpin.fail('Timed out waiting for clone job');
    process.exit(1);
    return;
  }
  if (final.status === 'failed') {
    pollSpin.fail(`Clone failed: ${final.error_message ?? '(no message)'}`);
    console.log(chalk.gray(`Retry with: butterbase clone --retry ${final.job_id}`));
    process.exit(1);
    return;
  }
  pollSpin.succeed(`Cloned to app ${final.dest_app_id}`);

  // Init + pull into target dir.
  const dir = targetDir ?? final.dest_app_id!;
  await fs.ensureDir(dir);
  const prevCwd = process.cwd();
  process.chdir(dir);
  try {
    await repoInitCommand(final.dest_app_id!, {});
    await repoPullCommand({});
  } finally {
    process.chdir(prevCwd);
  }

  if (opts.json) {
    console.log(JSON.stringify({ job_id: final.job_id, dest_app_id: final.dest_app_id, target_dir: path.resolve(dir) }, null, 2));
  } else {
    console.log(chalk.green(`✓ Cloned ${sourceAppId} → ${final.dest_app_id} into ${path.resolve(dir)}`));
  }
}
