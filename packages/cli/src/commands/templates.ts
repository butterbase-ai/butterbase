import chalk from 'chalk';
import { cloneApi } from '../lib/repo-api.js';

const VALID_SORT = new Set(['recent', 'popular']);

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function pad(s: string, width: number): string {
  return s.padEnd(width);
}

export async function templatesCommand(opts: {
  q?: string;
  sort?: string;
  region?: string;
  limit?: number;
  offset?: number;
  json?: boolean;
}): Promise<void> {
  if (opts.sort && !VALID_SORT.has(opts.sort)) {
    console.error(`error: --sort must be 'recent' or 'popular', got '${opts.sort}'`);
    process.exit(1);
    return;
  }

  let result;
  try {
    result = await cloneApi.list({
      q: opts.q,
      sort: opts.sort as 'recent' | 'popular' | undefined,
      region: opts.region,
      limit: opts.limit,
      offset: opts.offset,
    });
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    process.exit(1);
    return;
  }

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (!result.items.length) {
    console.log(chalk.gray('No templates found.'));
    return;
  }

  // Compute column widths.
  const COL_APP_ID = Math.max(6, ...result.items.map(r => r.app_id.length));
  const COL_NAME = Math.max(4, ...result.items.map(r => Math.min(r.name.length, 30)));
  const COL_REGION = Math.max(6, ...result.items.map(r => r.region.length));
  const COL_CLONES = 6;
  const COL_TABLES = 6;
  const COL_FUNCS = 9;

  const header = [
    pad('APP_ID', COL_APP_ID),
    pad('NAME', COL_NAME),
    pad('REGION', COL_REGION),
    pad('CLONES', COL_CLONES),
    pad('TABLES', COL_TABLES),
    pad('FUNCTIONS', COL_FUNCS),
  ].join('  ');

  console.log(chalk.dim(header));

  for (const item of result.items) {
    const row = [
      pad(item.app_id, COL_APP_ID),
      pad(truncate(item.name, 30), COL_NAME),
      pad(item.region, COL_REGION),
      pad(String(item.fork_count), COL_CLONES),
      pad(String(item.schema_summary.table_count), COL_TABLES),
      pad(String(item.schema_summary.function_count), COL_FUNCS),
    ].join('  ');
    console.log(row);
  }

  console.log(chalk.gray('Clone with: butterbase clone <APP_ID> [target_dir]'));
}
