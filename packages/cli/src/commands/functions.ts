import { text, msg } from '../lib/i18n.js';
import chalk from 'chalk';
import ora from 'ora';
import fs from 'fs-extra';
import { deployFunction, listFunctions, getFunctionLogs, deleteFunction, invokeFunction, updateFunctionEnv, getFunction } from '../lib/api-client.js';
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

export async function functionsListCommand(options: { app?: string }) {
  const appId = await requireAppId(options.app);
  const spinner = ora(text('Fetching functions...')).start();

  try {
    const response: any = await listFunctions(appId);
    spinner.stop();

    if (!response.functions || response.functions.length === 0) {
      console.log(chalk.yellow(text('No functions found')));
      return;
    }

    console.log(chalk.blue(text('\nDeployed functions:\n')));
    for (const func of response.functions) {
      console.log(chalk.bold(func.name));
      const triggerTypes = Array.isArray(func.triggers)
        ? func.triggers.map((t: { type: string }) => t.type).join(', ')
        : (func.trigger?.type ?? func.trigger_type ?? '—');
      console.log(chalk.gray(msg`  Triggers: ${triggerTypes}`));
      if (func.agent_tool) {
        const mode = func.agent_tool_mode ?? 'read_only';
        const exposed = func.agent_tool_exposed_to ?? 'developer_only';
        console.log(chalk.gray(msg`  🤖 Agent tool: ${mode}, exposed=${exposed}`));
      }
      if (func.description) {
        console.log(chalk.gray(msg`  Description: ${func.description}`));
      }
      console.log();
    }
  } catch (error) {
    spinner.fail(text('Failed to fetch functions'));
    console.error(chalk.red((error as Error).message));
    process.exit(1);
  }
}

export async function functionsGetCommand(name: string, options: { app?: string; output?: string; json?: boolean; sourceOnly?: boolean }) {
  const appId = await requireAppId(options.app);
  const spinner = ora(msg`Fetching function "${name}"...`).start();

  try {
    const fn: any = await getFunction(appId, name);
    spinner.stop();

    if (options.output) {
      await fs.writeFile(options.output, fn.code ?? '', 'utf-8');
      console.log(chalk.green(msg`✓ Wrote source code to ${options.output}`));
      return;
    }

    if (options.sourceOnly) {
      process.stdout.write(fn.code ?? '');
      return;
    }

    if (options.json) {
      console.log(JSON.stringify(fn, null, 2));
      return;
    }

    console.log(chalk.bold(`\n${fn.name}`));
    if (fn.description) console.log(chalk.gray(msg`  Description: ${fn.description}`));
    const triggerTypes = Array.isArray(fn.triggers)
      ? fn.triggers.map((t: { type: string }) => t.type).join(', ')
      : '—';
    console.log(chalk.gray(msg`  Triggers: ${triggerTypes}`));
    console.log(chalk.gray(msg`  Deployed: ${fn.deployedAt}`));
    if (fn.timeoutMs) console.log(chalk.gray(msg`  Timeout: ${fn.timeoutMs}ms`));
    if (fn.memoryLimitMb) console.log(chalk.gray(msg`  Memory: ${fn.memoryLimitMb}MB`));
    console.log(chalk.blue(text('\n--- Source ---')));
    console.log(fn.code ?? '');
  } catch (error) {
    spinner.fail(text('Failed to fetch function'));
    console.error(chalk.red((error as Error).message));
    process.exit(1);
  }
}

export async function functionsDeployCommand(file: string, options: {
  app?: string;
  name?: string;
  trigger?: string;
  triggerConfig?: string;
  description?: string;
  env?: string[];
  timeoutMs?: number;
  memoryMb?: number;
  agentTool?: boolean;
  agentToolDescription?: string;
  agentToolMode?: string;
  agentToolExposedTo?: string;
  /** --allow-impersonation / --no-allow-impersonation */
  allowImpersonation?: boolean;
}) {
  const appId = await requireAppId(options.app);

  if (!await fs.pathExists(file)) {
    console.log(chalk.red(msg`✗ File not found: ${file}`));
    process.exit(1);
  }

  const functionName = options.name || file.replace(/\.(ts|js)$/, '').split('/').pop()!;
  const spinner = ora(msg`Deploying function "${functionName}"...`).start();

  try {
    const code = await fs.readFile(file, 'utf-8');

    const triggerType = options.trigger || 'http';
    let triggerConfig: Record<string, unknown> = {};
    if (options.triggerConfig) {
      try {
        triggerConfig = JSON.parse(options.triggerConfig);
      } catch (e) {
        spinner.fail(text('Invalid --trigger-config (must be valid JSON)'));
        console.error(chalk.red((e as Error).message));
        process.exit(1);
      }
    }
    const trigger = { type: triggerType, config: triggerConfig };

    let envVars: Record<string, string> | undefined;
    if (options.env && options.env.length > 0) {
      envVars = {};
      for (const e of options.env) {
        const eq = e.indexOf('=');
        if (eq === -1) {
          spinner.fail(msg`Invalid --env entry: '${e}' (expected KEY=value)`);
          process.exit(1);
        }
        envVars[e.slice(0, eq)] = e.slice(eq + 1);
      }
    }

    const mode = options.agentToolMode;
    if (mode && mode !== 'read_only' && mode !== 'read_write') {
      spinner.fail(msg`Invalid --agent-tool-mode: '${mode}' (expected read_only or read_write)`);
      process.exit(1);
    }
    const exposed = options.agentToolExposedTo;
    if (exposed && exposed !== 'developer_only' && exposed !== 'end_user') {
      spinner.fail(msg`Invalid --agent-tool-exposed-to: '${exposed}' (expected developer_only or end_user)`);
      process.exit(1);
    }

    await deployFunction(appId, {
      name: functionName,
      code,
      description: options.description,
      trigger,
      ...(envVars ? { envVars } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.memoryMb !== undefined ? { memoryLimitMb: options.memoryMb } : {}),
      ...(options.agentTool !== undefined ? { agent_tool: options.agentTool } : {}),
      ...(options.agentToolDescription !== undefined ? { agent_tool_description: options.agentToolDescription } : {}),
      ...(mode ? { agent_tool_mode: mode as 'read_only' | 'read_write' } : {}),
      ...(exposed ? { agent_tool_exposed_to: exposed as 'developer_only' | 'end_user' } : {}),
      // Phase 2: per-fn impersonation gate. Default-on at the API; the flag
      // only travels in the body when the user explicitly passes --allow-
      // impersonation or --no-allow-impersonation.
      ...(options.allowImpersonation !== undefined ? { allow_service_key_impersonation: options.allowImpersonation } : {}),
    });

    spinner.succeed(msg`Deployed function "${functionName}"`);
    console.log(chalk.green(text('\n✓ Function deployed successfully!')));
    console.log(chalk.gray(msg`  Invoke URL: /v1/${appId}/fn/${functionName}`));
  } catch (error) {
    spinner.fail(text('Failed to deploy function'));
    console.error(chalk.red((error as Error).message));
    process.exit(1);
  }
}

export async function functionsLogsCommand(functionName: string, options: {
  app?: string;
  level?: string;
  limit?: number;
  includeDeleted?: boolean;
}) {
  const appId = await requireAppId(options.app);
  const spinner = ora(text('Fetching logs...')).start();

  try {
    const response: any = await getFunctionLogs(appId, functionName, options.level, options.limit, options.includeDeleted);
    spinner.stop();

    if (!response.logs || response.logs.length === 0) {
      console.log(chalk.yellow(text('No logs found')));
      return;
    }

    console.log(chalk.blue(msg`\nLogs for ${functionName}:\n`));
    for (const log of response.logs) {
      const timestamp = new Date(log.timestamp).toLocaleString();
      const hasError = !!log.error;
      const status = log.statusCode ? `${log.statusCode}` : '---';
      const duration = log.duration ? `${log.duration}ms` : '';
      const method = log.method || '';
      const statusColor = hasError ? chalk.red : chalk.green;

      let line = `${chalk.gray(timestamp)} ${method ? chalk.cyan(method.padEnd(5)) + ' ' : ''}${statusColor(status)}`;
      if (duration) line += ` ${chalk.gray(duration)}`;
      if (log.error) line += ` ${chalk.red(log.error)}`;

      console.log(line);

      // Show console.log output if present
      if (log.consoleLogs && log.consoleLogs.length > 0) {
        for (const entry of log.consoleLogs) {
          const levelColors: Record<string, typeof chalk.gray> = {
            error: chalk.red, warn: chalk.yellow, info: chalk.blue,
            debug: chalk.gray, log: chalk.white,
          };
          const color = levelColors[entry.level] || chalk.gray;
          console.log(`  ${color(`[${entry.level}]`)} ${entry.message}`);
        }
      }
    }
  } catch (error) {
    spinner.fail(text('Failed to fetch logs'));
    console.error(chalk.red((error as Error).message));
    process.exit(1);
  }
}

export async function functionsDeleteCommand(functionName: string, options: { app?: string }) {
  const appId = await requireAppId(options.app);
  const spinner = ora(msg`Deleting function "${functionName}"...`).start();

  try {
    await deleteFunction(appId, functionName);
    spinner.succeed(msg`Deleted function "${functionName}"`);
    console.log(chalk.green(text('\n✓ Function deleted successfully!')));
  } catch (error) {
    spinner.fail(text('Failed to delete function'));
    console.error(chalk.red((error as Error).message));
    process.exit(1);
  }
}

export async function functionsInvokeCommand(name: string, options: { app?: string; data?: string; json?: boolean }) {
  const appId = await requireAppId(options.app);

  let payload: unknown = {};
  if (options.data) {
    try {
      payload = JSON.parse(options.data);
    } catch {
      console.error(chalk.red(text('--data must be valid JSON')));
      process.exit(1);
    }
  } else if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString('utf-8').trim();
    if (raw) {
      try { payload = JSON.parse(raw); } catch { payload = raw; }
    }
  }

  const spinner = ora(msg`Invoking function "${name}"...`).start();
  try {
    const result: any = await invokeFunction(appId, name, payload);
    spinner.stop();
    if (typeof result === 'string') {
      console.log(result);
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
  } catch (error) {
    spinner.fail(text('Invocation failed'));
    console.error(chalk.red((error as Error).message));
    process.exit(1);
  }
}

export async function functionsEnvSetCommand(name: string, vars: string[], options: { app?: string }) {
  const appId = await requireAppId(options.app);

  if (!vars || vars.length === 0) {
    console.error(chalk.red(text('Provide at least one KEY=VALUE pair')));
    process.exit(1);
  }

  const parsed: Record<string, string> = {};
  for (const v of vars) {
    const eq = v.indexOf('=');
    if (eq === -1) {
      console.error(chalk.red(msg`Invalid format (expected KEY=VALUE): ${v}`));
      process.exit(1);
    }
    parsed[v.slice(0, eq)] = v.slice(eq + 1);
  }

  const spinner = ora(msg`Fetching current env for "${name}"...`).start();
  try {
    const fn: any = await getFunction(appId, name);
    const existing: Record<string, string> = fn.envVars ?? fn.env_vars ?? {};
    const merged = { ...existing, ...parsed };
    spinner.text = text('Updating env...');
    await updateFunctionEnv(appId, name, merged);
    spinner.succeed(msg`Updated env for function "${name}"`);
    console.log('');
    for (const k of Object.keys(parsed)) {
      console.log(msg`  ${chalk.cyan(k)} set`);
    }
    console.log('');
  } catch (error) {
    spinner.fail(text('Failed to update env'));
    console.error(chalk.red((error as Error).message));
    process.exit(1);
  }
}

export async function functionsEnvListCommand(name: string, options: { app?: string; json?: boolean }) {
  const appId = await requireAppId(options.app);
  const spinner = ora(msg`Fetching env for "${name}"...`).start();
  try {
    const fn: any = await getFunction(appId, name);
    spinner.stop();
    // Prefer the dedicated envKeys field (server-side decrypts + returns
    // keys only). Fall back to legacy envVars/env_vars shapes for older
    // control-api builds that still return the full encrypted record.
    const keys: string[] = Array.isArray(fn.envKeys)
      ? fn.envKeys
      : Object.keys((fn.envVars ?? fn.env_vars ?? {}) as Record<string, string>);
    if (options.json) {
      console.log(JSON.stringify({ keys }, null, 2));
      return;
    }
    if (keys.length === 0) {
      console.log(chalk.gray(msg`No env vars set for "${name}".`));
      return;
    }
    console.log('');
    for (const k of keys) {
      console.log(`  ${chalk.cyan(k)}`);
    }
    console.log('');
    console.log(chalk.gray(text('  (values are write-only — set with `butterbase functions env set <name> KEY=VALUE`)')));
  } catch (error) {
    spinner.fail(text('Failed to fetch env'));
    console.error(chalk.red((error as Error).message));
    process.exit(1);
  }
}

export async function functionsMetricsCommand(name: string, options: { app?: string; json?: boolean }) {
  const appId = await requireAppId(options.app);
  const spinner = ora(msg`Fetching metrics for "${name}"...`).start();
  try {
    const fn: any = await getFunction(appId, name);
    spinner.stop();
    const metrics = {
      invocationCount: Number(fn.invocationCount ?? 0),
      errorCount: Number(fn.errorCount ?? 0),
      errorRate: Number(fn.invocationCount ?? 0) > 0
        ? Number(fn.errorCount ?? 0) / Number(fn.invocationCount)
        : 0,
      avgDurationMs: Number(fn.avgDuration ?? 0),
      lastInvoked: fn.lastInvoked ?? null,
      deployedAt: fn.deployedAt ?? null,
    };
    if (options.json) {
      console.log(JSON.stringify(metrics, null, 2));
      return;
    }
    console.log('');
    console.log(chalk.bold(name));
    console.log(chalk.gray(msg`  Invocations:   ${metrics.invocationCount.toLocaleString()}`));
    console.log(chalk.gray(msg`  Errors:        ${metrics.errorCount.toLocaleString()}`));
    console.log(chalk.gray(msg`  Error rate:    ${(metrics.errorRate * 100).toFixed(2)}%`));
    console.log(chalk.gray(msg`  Avg duration:  ${metrics.avgDurationMs > 0 ? `${metrics.avgDurationMs.toFixed(0)} ms` : '—'}`));
    console.log(chalk.gray(msg`  Last invoked:  ${metrics.lastInvoked ?? '—'}`));
    console.log(chalk.gray(msg`  Deployed at:   ${metrics.deployedAt ?? '—'}`));
    console.log('');
  } catch (error) {
    spinner.fail(text('Failed to fetch metrics'));
    console.error(chalk.red((error as Error).message));
    process.exit(1);
  }
}
