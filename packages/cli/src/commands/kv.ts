import chalk from 'chalk';
import ora from 'ora';
import prompts from 'prompts';
import { kvApi } from '../lib/kv-api.js';
import { getCurrentAppId } from '../lib/config.js';
import { loadKvConfig, type KvExposeRule } from '../lib/load-kv-config.js';

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

// ---------------------------------------------------------------------------
// kv apply
// ---------------------------------------------------------------------------

export interface KvDiff {
  add: KvExposeRule[];
  remove: KvExposeRule[];
  change: Array<KvExposeRule & { from: KvExposeRule }>;
}

/**
 * Pure function: compute the diff between live rules and declared rules.
 * Keyed by pattern.
 */
export function computeDiff(live: KvExposeRule[], declared: KvExposeRule[]): KvDiff {
  const liveMap = new Map(live.map((r) => [r.pattern, r]));
  const declaredMap = new Map(declared.map((r) => [r.pattern, r]));

  const add: KvExposeRule[] = [];
  const remove: KvExposeRule[] = [];
  const change: Array<KvExposeRule & { from: KvExposeRule }> = [];

  for (const [pattern, decl] of declaredMap) {
    const liveRule = liveMap.get(pattern);
    if (!liveRule) {
      add.push(decl);
    } else if (liveRule.read !== decl.read || liveRule.write !== decl.write) {
      change.push({ ...decl, from: liveRule });
    }
  }

  for (const [pattern, liveRule] of liveMap) {
    if (!declaredMap.has(pattern)) {
      remove.push(liveRule);
    }
  }

  return { add, remove, change };
}

export async function kvApplyCommand(opts: {
  app?: string;
  file: string;
  dryRun?: boolean;
  yes?: boolean;
}) {
  const appId = await requireAppId(opts.app);

  // 1. Load config
  const config = await loadKvConfig(opts.file);
  const declared = config.expose;

  // 2. Fetch live rules
  const { rules: live } = await kvApi.listRules(appId) as { rules: KvExposeRule[] };

  // 3. Compute diff
  const diff = computeDiff(live, declared);

  const hasChanges = diff.add.length + diff.remove.length + diff.change.length > 0;

  // 4. Print preview
  if (!hasChanges) {
    console.log(chalk.gray('No changes — already up-to-date.'));
    return;
  }

  for (const r of diff.remove) {
    console.log(chalk.red(`  - ${r.pattern}  read=${r.read}  write=${r.write}`));
  }
  for (const r of diff.change) {
    console.log(
      chalk.yellow(
        `  ~ ${r.pattern}  read=${r.from.read}->${r.read}  write=${r.from.write}->${r.write}`,
      ),
    );
  }
  for (const r of diff.add) {
    console.log(chalk.green(`  + ${r.pattern}  read=${r.read}  write=${r.write}`));
  }

  // 5. Dry-run stops here
  if (opts.dryRun) {
    console.log(chalk.gray('\n(dry-run — no changes applied)'));
    return;
  }

  // 6. Confirm unless --yes
  if (!opts.yes) {
    const { confirmed } = await prompts({
      type: 'confirm',
      name: 'confirmed',
      message: 'Apply these changes?',
      initial: false,
    });
    if (!confirmed) {
      console.log(chalk.gray('Aborted.'));
      return;
    }
  }

  // 7. Apply: removes first, then adds + changes
  const spinner = ora('Applying…').start();
  try {
    for (const r of diff.remove) {
      await kvApi.unexpose(appId, r.pattern);
    }
    for (const r of [...diff.add, ...diff.change]) {
      await kvApi.expose(appId, r.pattern, r.read, r.write);
    }
    spinner.succeed(
      `Applied: ${diff.remove.length} removed, ${diff.add.length} added, ${diff.change.length} changed.`,
    );
  } catch (err) {
    spinner.fail('Apply failed');
    throw err;
  }
}
