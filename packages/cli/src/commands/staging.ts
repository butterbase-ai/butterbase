import chalk from 'chalk';
import ora from 'ora';
import { apiGet, apiPost, apiPut, apiDelete } from '../lib/api-client.js';
import { getCurrentAppId } from '../lib/config.js';
import { cloneApi, type CloneJob } from '../lib/repo-api.js';

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;

async function requireAppId(opt?: string): Promise<string> {
  if (opt) return opt;
  const cur = await getCurrentAppId();
  if (!cur) {
    console.log(chalk.red('✗ no app — use `butterbase apps use <id>` or --app'));
    process.exit(1);
    return undefined as unknown as string;
  }
  return cur;
}

async function pollStagingJob(jobId: string, label: string): Promise<CloneJob | undefined> {
  const spin = ora(`${label}…`).start();
  const start = Date.now();
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    let cur: CloneJob;
    try {
      cur = await cloneApi.get(jobId);
    } catch (e) {
      spin.fail((e as Error).message);
      process.exit(1);
      return undefined;
    }
    if (cur.status === 'completed' || cur.status === 'failed') {
      spin.stop();
      if (cur.status === 'failed') {
        ora().fail(`Job failed: ${cur.error_message ?? '(no message)'}`);
        process.exit(1);
        return undefined;
      }
      return cur;
    }
    spin.text = `${label}… (${cur.status})`;
  }
  ora().fail('Timed out waiting for job');
  process.exit(1);
  return undefined;
}

export async function stagingCreateCommand(opts: { app?: string; wait?: boolean; json?: boolean }) {
  const appId = await requireAppId(opts.app);
  const spin = ora('Creating staging environment…').start();
  let result: { job_id: string };
  try {
    result = await apiPost<{ job_id: string }>(`/v1/apps/${appId}/staging`, {});
  } catch (e) {
    spin.fail((e as Error).message);
    process.exit(1);
    return;
  }
  spin.succeed(`Staging job ${result.job_id} started`);
  console.log(chalk.gray(`  Production data is being copied — this can take a few minutes.`));
  console.log(chalk.gray(`  Poll with: butterbase staging status --app ${appId}`));

  if (opts.wait) {
    const final = await pollStagingJob(result.job_id, 'Waiting for staging to be ready');
    if (!final) return;
    if (final.warnings?.length) {
      for (const w of final.warnings) console.log(chalk.yellow(`warning: ${w}`));
    }
    if (opts.json) {
      console.log(JSON.stringify({ job_id: final.job_id, staging_app_id: final.dest_app_id, warnings: final.warnings }));
    } else {
      console.log(chalk.green(`✓ Staging ready — app id: ${final.dest_app_id}`));
    }
    return;
  }

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  }
}

export async function stagingStatusCommand(opts: { app?: string; json?: boolean }) {
  const appId = await requireAppId(opts.app);
  const result = await apiGet<{
    staging_app_id: string | null;
    last_promoted_at: string | null;
    last_reset_at: string | null;
  }>(`/v1/apps/${appId}/staging`);

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (!result.staging_app_id) {
    console.log(chalk.gray('No staging environment. Create one with: butterbase staging create'));
    return;
  }
  console.log(`Staging app:     ${result.staging_app_id}`);
  console.log(`Last promoted:   ${result.last_promoted_at ?? 'never'}`);
  console.log(`Last reset:      ${result.last_reset_at ?? 'never'}`);
}

export async function stagingResetCommand(opts: { app?: string; wait?: boolean; json?: boolean }) {
  const appId = await requireAppId(opts.app);
  const spin = ora('Resetting staging environment…').start();
  let result: { job_id: string };
  try {
    result = await apiPost<{ job_id: string }>(`/v1/apps/${appId}/staging/reset`, {});
  } catch (e) {
    spin.fail((e as Error).message);
    process.exit(1);
    return;
  }
  spin.succeed(`Reset job ${result.job_id} started`);

  if (opts.wait) {
    const final = await pollStagingJob(result.job_id, 'Waiting for reset to complete');
    if (!final) return;
    if (final.warnings?.length) {
      for (const w of final.warnings) console.log(chalk.yellow(`warning: ${w}`));
    }
    if (opts.json) {
      console.log(JSON.stringify({ job_id: final.job_id, warnings: final.warnings }));
    } else {
      console.log(chalk.green('✓ Staging reset complete'));
    }
    return;
  }

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  }
}

export async function stagingDeleteCommand(opts: { app?: string; yes?: boolean; json?: boolean }) {
  const appId = await requireAppId(opts.app);
  if (!opts.yes) {
    const { default: prompts } = await import('prompts');
    const { confirmed } = await prompts({
      type: 'confirm',
      name: 'confirmed',
      message: 'Delete staging environment? This is irreversible.',
      initial: false,
    });
    if (!confirmed) {
      console.log(chalk.gray('Aborted.'));
      return;
    }
  }
  const spin = ora('Deleting staging environment…').start();
  try {
    await apiDelete(`/v1/apps/${appId}/staging`);
  } catch (e) {
    spin.fail((e as Error).message);
    process.exit(1);
    return;
  }
  spin.succeed('Staging environment deleted');
  if (opts.json) console.log(JSON.stringify({ deleted: true }));
}

export async function stagingEnvGetCommand(opts: { app?: string; json?: boolean }) {
  const appId = await requireAppId(opts.app);
  const result = await apiGet<{ env_overrides: Record<string, string> }>(
    `/v1/apps/${appId}/staging/env-overrides`,
  );
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const keys = Object.keys(result.env_overrides ?? {});
  if (keys.length === 0) {
    console.log(chalk.gray('(no overrides set)'));
    return;
  }
  for (const k of keys) console.log(k);
}

export async function stagingEnvSetCommand(vars: string[], opts: { app?: string; json?: boolean }) {
  const appId = await requireAppId(opts.app);
  const env_overrides: Record<string, string> = {};
  for (const v of vars) {
    const eq = v.indexOf('=');
    if (eq < 1) {
      console.log(chalk.red(`✗ invalid format (expected KEY=value): ${v}`));
      process.exit(1);
      return;
    }
    env_overrides[v.slice(0, eq)] = v.slice(eq + 1);
  }
  const result = await apiPut(`/v1/apps/${appId}/staging/env-overrides`, { env_overrides });
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(chalk.green(`✓ set ${Object.keys(env_overrides).length} override(s)`));
  }
}

export async function stagingPromotePreviewCommand(opts: { app?: string; json?: boolean }) {
  const appId = await requireAppId(opts.app);
  const result = await apiGet<{
    can_promote: boolean;
    additive: unknown[];
    blocked: unknown[];
    ignored_removals: unknown[];
  }>(`/v1/apps/${appId}/staging/promote/preview`);

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`Can promote: ${result.can_promote ? chalk.green('yes') : chalk.red('no')}`);
  if (result.additive?.length) {
    console.log(chalk.green(`\nAdditive changes (${result.additive.length}):`));
    console.log(JSON.stringify(result.additive, null, 2));
  }
  if (result.blocked?.length) {
    console.log(chalk.red(`\nBlocked changes (${result.blocked.length}) — apply manually or roll back:`));
    console.log(JSON.stringify(result.blocked, null, 2));
  }
  if (result.ignored_removals?.length) {
    console.log(chalk.gray(`\nIgnored removals (${result.ignored_removals.length}) — not promoted:`));
    console.log(JSON.stringify(result.ignored_removals, null, 2));
  }
}

export async function stagingPromoteRunCommand(opts: { app?: string; yes?: boolean; wait?: boolean; json?: boolean }) {
  const appId = await requireAppId(opts.app);
  if (!opts.yes) {
    const { default: prompts } = await import('prompts');
    const { confirmed } = await prompts({
      type: 'confirm',
      name: 'confirmed',
      message: 'Promote staging to production? This deploys schema + functions to production.',
      initial: false,
    });
    if (!confirmed) {
      console.log(chalk.gray('Aborted.'));
      return;
    }
  }
  const spin = ora('Starting promote…').start();
  let result: { job_id: string };
  try {
    result = await apiPost<{ job_id: string }>(`/v1/apps/${appId}/staging/promote`, {});
  } catch (e) {
    spin.fail((e as Error).message);
    process.exit(1);
    return;
  }
  spin.succeed(`Promote job ${result.job_id} started`);

  if (opts.wait) {
    const final = await pollStagingJob(result.job_id, 'Waiting for promote to complete');
    if (!final) return;
    if (final.warnings?.length) {
      for (const w of final.warnings) console.log(chalk.yellow(`warning: ${w}`));
    }
    if (opts.json) {
      console.log(JSON.stringify({ job_id: final.job_id, warnings: final.warnings }));
    } else {
      console.log(chalk.green('✓ Promote complete — production updated'));
    }
    return;
  }

  if (opts.json) console.log(JSON.stringify(result, null, 2));
}
