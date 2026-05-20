import chalk from 'chalk';
import ora from 'ora';
import {
  aiChat, aiEmbed, aiListModels, aiGetConfig, aiUpdateConfig, aiGetUsage,
} from '../lib/api-client.js';
import { getCurrentAppId } from '../lib/config.js';

async function requireAppId(appId?: string): Promise<string> {
  if (appId) return appId;
  const current = await getCurrentAppId();
  if (!current) {
    console.log(chalk.red('No app specified and no current app set'));
    console.log(chalk.gray('Use: butterbase apps use <app-id>'));
    process.exit(1);
  }
  return current;
}

export async function aiChatCommand(prompt: string, options: { app?: string; model?: string; temperature?: number; maxTokens?: number; system?: string; json?: boolean }) {
  const appId = await requireAppId(options.app);
  const messages: any[] = [];
  if (options.system) messages.push({ role: 'system', content: options.system });
  messages.push({ role: 'user', content: prompt });
  const spinner = ora('Calling AI...').start();
  try {
    const r: any = await aiChat(appId, {
      messages, stream: false,
      ...(options.model ? { model: options.model } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
    });
    spinner.stop();
    if (options.json) return console.log(JSON.stringify(r, null, 2));
    const content = r.choices?.[0]?.message?.content;
    console.log(content ?? JSON.stringify(r, null, 2));
  } catch (e) {
    spinner.fail('AI request failed');
    console.error(chalk.red((e as Error).message));
    process.exit(1);
  }
}

export async function aiEmbedCommand(input: string[], options: { app?: string; model?: string; json?: boolean }) {
  const appId = await requireAppId(options.app);
  const body: any = { input: input.length === 1 ? input[0] : input };
  if (options.model) body.model = options.model;
  const spinner = ora('Embedding...').start();
  try {
    const r: any = await aiEmbed(appId, body);
    spinner.stop();
    if (options.json) return console.log(JSON.stringify(r, null, 2));
    console.log(`${r.data?.length ?? 0} embedding(s)  model=${r.model ?? '?'}  tokens=${r.usage?.total_tokens ?? '?'}`);
  } catch (e) {
    spinner.fail('Embed failed');
    console.error(chalk.red((e as Error).message));
    process.exit(1);
  }
}

export async function aiModelsCommand(options: { app?: string; json?: boolean }) {
  const appId = await requireAppId(options.app);
  const spinner = ora('Fetching models...').start();
  try {
    const r: any = await aiListModels(appId);
    spinner.stop();
    if (options.json) return console.log(JSON.stringify(r, null, 2));
    for (const m of r.models ?? []) {
      const ctx = m.context_window ? `  ctx=${m.context_window}` : '';
      const caps = m.capabilities ? `  ${m.capabilities.join(',')}` : '';
      console.log(`${m.id}  (${m.provider})${caps}${ctx}`);
    }
  } catch (e) {
    spinner.fail('List models failed');
    console.error(chalk.red((e as Error).message));
    process.exit(1);
  }
}

export async function aiConfigGetCommand(options: { app?: string; json?: boolean }) {
  const appId = await requireAppId(options.app);
  try {
    const r = await aiGetConfig(appId);
    console.log(options.json ? JSON.stringify(r, null, 2) : r);
  } catch (e) {
    console.error(chalk.red((e as Error).message));
    process.exit(1);
  }
}

export async function aiConfigSetCommand(options: { app?: string; defaultModel?: string; allowedModels?: string[]; maxTokensPerRequest?: number; byokKey?: string; json?: boolean }) {
  const appId = await requireAppId(options.app);
  const body: Record<string, unknown> = {};
  if (options.defaultModel) body.defaultModel = options.defaultModel;
  if (options.allowedModels) body.allowedModels = options.allowedModels;
  if (options.maxTokensPerRequest !== undefined) body.maxTokensPerRequest = options.maxTokensPerRequest;
  if (options.byokKey !== undefined) body.byokKey = options.byokKey;
  if (Object.keys(body).length === 0) {
    console.log(chalk.yellow('Nothing to update — pass at least one of --default-model, --allowed-models, --max-tokens-per-request, --byok-key'));
    process.exit(1);
  }
  const spinner = ora('Updating AI config...').start();
  try {
    const r = await aiUpdateConfig(appId, body);
    spinner.succeed('AI config updated');
    if (options.json) console.log(JSON.stringify(r, null, 2));
  } catch (e) {
    spinner.fail('Update failed');
    console.error(chalk.red((e as Error).message));
    process.exit(1);
  }
}

export async function aiUsageCommand(options: { app?: string; startDate?: string; endDate?: string; json?: boolean }) {
  const appId = await requireAppId(options.app);
  try {
    const r = await aiGetUsage(appId, { startDate: options.startDate, endDate: options.endDate });
    console.log(options.json ? JSON.stringify(r, null, 2) : r);
  } catch (e) {
    console.error(chalk.red((e as Error).message));
    process.exit(1);
  }
}
