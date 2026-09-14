import chalk from 'chalk';
import ora from 'ora';
import { apiGet, apiPost, apiPut, apiDelete } from '../lib/api-client.js';
import { getCurrentAppId } from '../lib/config.js';
import { cloneApi, type CloneJob } from '../lib/repo-api.js';

// The product calls these "preview deployments". The REST surface still says
// /staging — the control-api routes, the app_environments link row and the
// staging_env_overrides table all predate the rename — so the paths below keep
// the old spelling on purpose. Only what a user reads says "preview".

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

/**
 * Fail a spinner using the server's own words.
 *
 * Plan-gated routes answer 403 with a sentence plus an upgrade URL, which the
 * SDK surfaces as message + remediation. Printing both is what turns a dead
 * end into a next step. Never restate the plan name here: the server owns that
 * copy, and a stale client copy is how "upgrade to Pro" outlived the Pro plan.
 */
function failSpinner(spin: ReturnType<typeof ora>, err: unknown): never {
  const e = err as { message?: string; remediation?: string };
  spin.fail(e?.message ?? String(err));
  if (e?.remediation) console.log(chalk.gray(`  ${e.remediation}`));
  process.exit(1);
}

async function pollPreviewJob(jobId: string, label: string): Promise<CloneJob | undefined> {
  const spin = ora(`${label}…`).start();
  const start = Date.now();
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    let cur: CloneJob;
    try {
      cur = await cloneApi.get(jobId);
    } catch (e) {
      failSpinner(spin, e);
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

function printWarnings(final: CloneJob) {
  if (final.warnings?.length) {
    for (const w of final.warnings) console.log(chalk.yellow(`warning: ${w}`));
  }
}

export async function previewCreateCommand(opts: { app?: string; wait?: boolean; json?: boolean }) {
  const appId = await requireAppId(opts.app);
  const spin = ora('Creating preview deployment…').start();
  let result: { job_id: string };
  try {
    result = await apiPost<{ job_id: string }>(`/v1/apps/${appId}/staging`, {});
  } catch (e) {
    failSpinner(spin, e);
  }
  spin.succeed(`Preview job ${result.job_id} started`);
  console.log(chalk.gray(`  Production data is being copied — this can take a few minutes.`));
  console.log(chalk.gray(`  Poll with: butterbase preview status --app ${appId}`));

  if (opts.wait) {
    const final = await pollPreviewJob(result.job_id, 'Waiting for the preview to be ready');
    if (!final) return;
    printWarnings(final);
    if (opts.json) {
      console.log(JSON.stringify({ job_id: final.job_id, preview_app_id: final.dest_app_id, warnings: final.warnings }));
    } else {
      console.log(chalk.green(`✓ Preview ready — app id: ${final.dest_app_id}`));
    }
    return;
  }

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  }
}

export async function previewStatusCommand(opts: { app?: string; json?: boolean }) {
  const appId = await requireAppId(opts.app);
  const result = await apiGet<{
    staging_app_id: string | null;
    last_promoted_at: string | null;
    last_reset_at: string | null;
  }>(`/v1/apps/${appId}/staging`);

  // Re-key the wire field so every JSON this command group emits says
  // "preview" — a caller should not have to know the REST spelling.
  if (opts.json) {
    const { staging_app_id, ...rest } = result;
    console.log(JSON.stringify({ preview_app_id: staging_app_id, ...rest }, null, 2));
    return;
  }

  if (!result.staging_app_id) {
    console.log(chalk.gray('No preview deployment. Create one with: butterbase preview create'));
    return;
  }
  console.log(`Preview app:     ${result.staging_app_id}`);
  console.log(`Last promoted:   ${result.last_promoted_at ?? 'never'}`);
  console.log(`Last reset:      ${result.last_reset_at ?? 'never'}`);
}

export async function previewResetCommand(opts: { app?: string; wait?: boolean; json?: boolean }) {
  const appId = await requireAppId(opts.app);
  const spin = ora('Resetting preview deployment…').start();
  let result: { job_id: string };
  try {
    result = await apiPost<{ job_id: string }>(`/v1/apps/${appId}/staging/reset`, {});
  } catch (e) {
    failSpinner(spin, e);
  }
  spin.succeed(`Reset job ${result.job_id} started`);

  if (opts.wait) {
    const final = await pollPreviewJob(result.job_id, 'Waiting for reset to complete');
    if (!final) return;
    printWarnings(final);
    if (opts.json) {
      console.log(JSON.stringify({ job_id: final.job_id, warnings: final.warnings }));
    } else {
      console.log(chalk.green('✓ Preview reset complete'));
    }
    return;
  }

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  }
}

export async function previewDeleteCommand(opts: { app?: string; yes?: boolean; json?: boolean }) {
  const appId = await requireAppId(opts.app);
  if (!opts.yes) {
    const { default: prompts } = await import('prompts');
    const { confirmed } = await prompts({
      type: 'confirm',
      name: 'confirmed',
      message: 'Delete this preview deployment? This is irreversible.',
      initial: false,
    });
    if (!confirmed) {
      console.log(chalk.gray('Aborted.'));
      return;
    }
  }
  const spin = ora('Deleting preview deployment…').start();
  try {
    await apiDelete(`/v1/apps/${appId}/staging`);
  } catch (e) {
    failSpinner(spin, e);
  }
  spin.succeed('Preview deployment deleted');
  if (opts.json) console.log(JSON.stringify({ deleted: true }));
}

export async function previewEnvGetCommand(opts: { app?: string; json?: boolean }) {
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

export async function previewEnvSetCommand(vars: string[], opts: { app?: string; json?: boolean }) {
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

export async function previewPromoteCheckCommand(opts: { app?: string; json?: boolean }) {
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

export async function previewPromoteRunCommand(opts: { app?: string; yes?: boolean; wait?: boolean; json?: boolean }) {
  const appId = await requireAppId(opts.app);
  if (!opts.yes) {
    const { default: prompts } = await import('prompts');
    const { confirmed } = await prompts({
      type: 'confirm',
      name: 'confirmed',
      message: 'Promote this preview to production? This deploys schema + functions to production.',
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
    failSpinner(spin, e);
  }
  spin.succeed(`Promote job ${result.job_id} started`);

  if (opts.wait) {
    const final = await pollPreviewJob(result.job_id, 'Waiting for promote to complete');
    if (!final) return;
    printWarnings(final);
    if (opts.json) {
      console.log(JSON.stringify({ job_id: final.job_id, warnings: final.warnings }));
    } else {
      console.log(chalk.green('✓ Promote complete — production updated'));
    }
    return;
  }

  if (opts.json) console.log(JSON.stringify(result, null, 2));
}
