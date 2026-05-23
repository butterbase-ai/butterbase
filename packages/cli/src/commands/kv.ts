import chalk from 'chalk';
import ora from 'ora';
import { kvApi } from '../lib/kv-api.js';
import { getCurrentAppId } from '../lib/config.js';

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

function parseValue(raw: string): unknown {
  try { return JSON.parse(raw); } catch { return raw; }
}

function parseTtl(t: string | undefined): number | null | undefined {
  if (t === undefined) return undefined;
  if (t === 'null' || t === 'forever') return null;
  // Support shorthand like 30d / 1h / 60s
  const m = /^(\d+)\s*([smhd])?$/.exec(t.trim());
  if (!m) { console.log(chalk.red(`✗ bad --ttl: ${t}`)); process.exit(1); }
  const n = Number(m[1]);
  const mult = ({ s: 1, m: 60, h: 3600, d: 86400 } as Record<string, number>)[m[2] ?? 's'] ?? 1;
  return n * mult;
}

export async function kvGetCommand(key: string, opts: { app?: string; raw?: boolean }) {
  const appId = await requireAppId(opts.app);
  const res = await kvApi.get(appId, key, opts.raw);
  console.log(typeof res === 'string' ? res : JSON.stringify(res, null, 2));
}

export async function kvSetCommand(key: string, value: string, opts: { app?: string; ttl?: string; ephemeral?: boolean }) {
  const appId = await requireAppId(opts.app);
  const ttl = parseTtl(opts.ttl);
  await kvApi.set(appId, key, parseValue(value), { ttl, ephemeral: opts.ephemeral });
  console.log(chalk.green(`✓ set ${key}`));
}

export async function kvDelCommand(key: string, opts: { app?: string }) {
  const appId = await requireAppId(opts.app);
  const res = await kvApi.del(appId, key);
  console.log(chalk.green(`✓ del — ${JSON.stringify(res)}`));
}

export async function kvLsCommand(opts: { app?: string; prefix?: string; limit?: string }) {
  const appId = await requireAppId(opts.app);
  const limit = Number(opts.limit ?? '100');
  const res = await kvApi.scan(appId, opts.prefix ?? '', limit) as { keys: string[]; cursor: string };
  for (const k of res.keys) console.log(k);
  if (res.cursor !== '0') console.log(chalk.gray(`-- next cursor: ${res.cursor}`));
}

export async function kvStatsCommand(opts: { app?: string }) {
  const appId = await requireAppId(opts.app);
  console.log(JSON.stringify(await kvApi.stats(appId), null, 2));
}

export async function kvFlushCommand(opts: { app?: string; confirm?: boolean; includeConfig?: boolean }) {
  if (!opts.confirm) {
    console.log(chalk.red('✗ refusing to flush without --confirm'));
    process.exit(1);
    return;
  }
  const appId = await requireAppId(opts.app);
  const spinner = ora('Flushing KV…').start();
  const res = await kvApi.flush(appId, opts.includeConfig);
  spinner.succeed(`Flushed (${JSON.stringify(res)})`);
}

export async function kvRulesCommand(opts: { app?: string }) {
  const appId = await requireAppId(opts.app);
  const { rules } = await kvApi.listRules(appId) as { rules: { pattern: string; read: string; write: string }[] };
  if (rules.length === 0) { console.log(chalk.gray('(no rules)')); return; }
  for (const r of rules) console.log(`${r.pattern.padEnd(40)}  read=${r.read}  write=${r.write}`);
}

export async function kvExposeCommand(pattern: string, opts: { app?: string; read: string; write: string }) {
  const appId = await requireAppId(opts.app);
  await kvApi.expose(appId, pattern, opts.read, opts.write);
  console.log(chalk.green(`✓ exposed ${pattern}`));
}

export async function kvUnexposeCommand(pattern: string, opts: { app?: string }) {
  const appId = await requireAppId(opts.app);
  await kvApi.unexpose(appId, pattern);
  console.log(chalk.green(`✓ unexposed ${pattern}`));
}
