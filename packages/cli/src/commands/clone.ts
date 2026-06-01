import chalk from 'chalk';
import ora from 'ora';
import fs from 'fs-extra';
import path from 'path';
import { cloneApi, CloneJob } from '../lib/repo-api.js';
import { repoInitCommand, repoPullCommand } from './repo.js';

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

/** Poll a clone job until it reaches a terminal status.
 *  Returns the completed CloneJob on success, or undefined when process.exit(1) was called. */
async function pollCloneJob(jobId: string): Promise<CloneJob | undefined> {
  const pollSpin = ora('Waiting for clone to complete…').start();
  const start = Date.now();
  let final: CloneJob | undefined;
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    let cur: CloneJob;
    try {
      cur = await cloneApi.get(jobId);
    } catch (e) {
      pollSpin.fail((e as Error).message);
      process.exit(1);
      return undefined;
    }
    if (cur.status === 'completed' || cur.status === 'failed') {
      final = cur;
      pollSpin.stop();
      break;
    }
    pollSpin.text = `Waiting for clone to complete… (${cur.status})`;
  }
  if (!final) {
    ora().fail('Timed out waiting for clone job');
    process.exit(1);
    return undefined;
  }
  if (final.status === 'failed') {
    ora().fail(`Clone failed: ${final.error_message ?? '(no message)'}`);
    console.log(chalk.gray(`Retry with: butterbase clone --retry ${final.job_id}`));
    process.exit(1);
    return undefined;
  }
  return final;
}

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

  const final = await pollCloneJob(job.job_id);
  if (!final) return;

  ora().succeed(`Cloned to app ${final.dest_app_id}`);

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

export async function cloneRetryCommand(
  jobId: string,
  targetDir: string | undefined,
  opts: { json?: boolean },
) {
  const retrySpin = ora(`Retrying clone job ${jobId}…`).start();
  let job;
  try {
    job = await cloneApi.retry(jobId);
  } catch (e) {
    retrySpin.fail((e as Error).message);
    process.exit(1);
    return;
  }
  retrySpin.succeed(`Clone job ${job.job_id} re-queued`);

  const final = await pollCloneJob(job.job_id);
  if (!final) return;

  ora().succeed(`Cloned to app ${final.dest_app_id}`);

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
    console.log(chalk.green(`✓ Retried clone job ${jobId} → ${final.dest_app_id} into ${path.resolve(dir)}`));
  }
}
