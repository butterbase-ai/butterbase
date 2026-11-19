import { text, msg } from '../lib/i18n.js';
import chalk from 'chalk';
import ora from 'ora';
import fs from 'fs-extra';
import prompts from 'prompts';
import { listAgents, getAgent, createAgent, updateAgent, deleteAgent } from '../lib/api-client.js';
import { getCurrentAppId } from '../lib/config.js';

async function requireAppId(appId?: string): Promise<string> {
  if (appId) return appId;

  const currentAppId = await getCurrentAppId();
  if (!currentAppId) {
    console.log(chalk.red(text('✗ No app specified and no current app set')));
    console.log(chalk.gray(text('Use: butterbase apps use <app-id>')));
    process.exit(1);
  }

  return currentAppId;
}

async function readSpecFile(filePath: string): Promise<Record<string, unknown>> {
  if (!await fs.pathExists(filePath)) {
    console.log(chalk.red(msg`✗ File not found: ${filePath}`));
    process.exit(1);
  }

  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch (err) {
    console.log(chalk.red(msg`✗ Failed to read file: ${filePath}`));
    process.exit(1);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw!);
  } catch {
    console.log(chalk.red(msg`✗ File is not valid JSON: ${filePath}`));
    process.exit(1);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    console.log(chalk.red(msg`✗ Spec file must be a JSON object: ${filePath}`));
    process.exit(1);
  }

  return parsed as Record<string, unknown>;
}

export async function agentsListCommand(app: string) {
  const appId = await requireAppId(app);
  const spinner = ora(text('Fetching agents...')).start();

  try {
    const response: any = await listAgents(appId);
    spinner.stop();

    const agents = response.agents || [];
    if (agents.length === 0) {
      console.log(chalk.yellow(text('No agents found')));
      return;
    }

    console.log(chalk.blue(text('\nAgents:\n')));
    for (const agent of agents) {
      console.log(chalk.bold(agent.name));
      if (agent.display_name) {
        console.log(chalk.gray(msg`  Display name: ${agent.display_name}`));
      }
      if (agent.description) {
        console.log(chalk.gray(msg`  Description:  ${agent.description}`));
      }
      if (agent.visibility) {
        console.log(chalk.gray(msg`  Visibility:   ${agent.visibility}`));
      }
      if (agent.default_model) {
        console.log(chalk.gray(msg`  Model:        ${agent.default_model}`));
      }
      console.log();
    }
  } catch (error) {
    spinner.fail(text('Failed to fetch agents'));
    console.error(chalk.red((error as Error).message));
    process.exit(1);
  }
}

export async function agentsGetCommand(app: string, name: string) {
  const appId = await requireAppId(app);
  const spinner = ora(msg`Fetching agent "${name}"...`).start();

  try {
    const response: any = await getAgent(appId, name);
    spinner.stop();

    const agent = response.agent ?? response;

    console.log(chalk.blue(msg`\nAgent: ${chalk.bold(agent.name)}\n`));
    if (agent.display_name) console.log(chalk.gray(msg`  Display name:              ${agent.display_name}`));
    if (agent.description)  console.log(chalk.gray(msg`  Description:               ${agent.description}`));
    if (agent.visibility)   console.log(chalk.gray(msg`  Visibility:                ${agent.visibility}`));
    if (agent.default_model) console.log(chalk.gray(msg`  Default model:             ${agent.default_model}`));
    if (agent.max_runs_per_user_per_hour != null) console.log(chalk.gray(msg`  Max runs/user/hour:        ${agent.max_runs_per_user_per_hour}`));
    if (agent.max_runs_per_ip_per_hour != null)   console.log(chalk.gray(msg`  Max runs/IP/hour:          ${agent.max_runs_per_ip_per_hour}`));
    if (agent.max_runs_per_app_per_hour != null)  console.log(chalk.gray(msg`  Max runs/app/hour:         ${agent.max_runs_per_app_per_hour}`));
    if (agent.daily_budget_usd != null)           console.log(chalk.gray(msg`  Daily budget (USD):        ${agent.daily_budget_usd}`));
    if (agent.max_concurrent_runs != null)        console.log(chalk.gray(msg`  Max concurrent runs:       ${agent.max_concurrent_runs}`));
    if (agent.graph_spec)   console.log(chalk.gray(msg`  Graph spec:                ${JSON.stringify(agent.graph_spec)}`));
    console.log();
  } catch (error) {
    spinner.fail(msg`Failed to fetch agent "${name}"`);
    console.error(chalk.red((error as Error).message));
    process.exit(1);
  }
}

export async function agentsCreateCommand(app: string, options: { file: string }) {
  const appId = await requireAppId(app);

  if (!options.file) {
    console.log(chalk.red(text('✗ --file is required')));
    console.log(chalk.gray(text('Usage: butterbase agents create <app> --file path/to/spec.json')));
    process.exit(1);
  }

  const spec = await readSpecFile(options.file);

  if (!spec.name || typeof spec.name !== 'string') {
    console.log(chalk.red(text('✗ Spec file must include a top-level "name" field')));
    process.exit(1);
  }

  const agentName = spec.name as string;
  const spinner = ora(msg`Creating agent "${agentName}"...`).start();

  try {
    const response: any = await createAgent(appId, spec);
    spinner.succeed(msg`Created agent "${agentName}"`);
    console.log(chalk.green(text('\n✓ Agent created successfully!')));
    const agent = response.agent ?? response;
    if (agent.name) console.log(chalk.gray(msg`  Name: ${agent.name}`));
  } catch (error) {
    spinner.fail(msg`Failed to create agent "${agentName}"`);
    console.error(chalk.red((error as Error).message));
    process.exit(1);
  }
}

export async function agentsUpdateCommand(app: string, name: string, options: { file: string }) {
  const appId = await requireAppId(app);

  if (!options.file) {
    console.log(chalk.red(text('✗ --file is required')));
    console.log(chalk.gray(text('Usage: butterbase agents update <app> <name> --file path/to/spec.json')));
    process.exit(1);
  }

  const spec = await readSpecFile(options.file);

  // Remove name from body — the URL carries the identity
  const { name: _name, ...body } = spec;

  const spinner = ora(msg`Updating agent "${name}"...`).start();

  try {
    await updateAgent(appId, name, body);
    spinner.succeed(msg`Updated agent "${name}"`);
    console.log(chalk.green(text('\n✓ Agent updated successfully!')));
  } catch (error) {
    spinner.fail(msg`Failed to update agent "${name}"`);
    console.error(chalk.red((error as Error).message));
    process.exit(1);
  }
}

export async function agentsDeleteCommand(app: string, name: string, options: { yes?: boolean }) {
  const appId = await requireAppId(app);

  if (!options.yes) {
    const { confirm } = await prompts({
      type: 'confirm',
      name: 'confirm',
      message: msg`Are you sure you want to delete agent "${name}"? This cannot be undone.`,
      initial: false,
    });

    if (!confirm) {
      console.log(chalk.yellow(text('Cancelled')));
      return;
    }
  }

  const spinner = ora(msg`Deleting agent "${name}"...`).start();

  try {
    await deleteAgent(appId, name);
    spinner.succeed(msg`Deleted agent "${name}"`);
    console.log(chalk.green(text('\n✓ Agent deleted successfully!')));
  } catch (error) {
    spinner.fail(msg`Failed to delete agent "${name}"`);
    console.error(chalk.red((error as Error).message));
    process.exit(1);
  }
}
