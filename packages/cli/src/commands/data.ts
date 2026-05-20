import chalk from 'chalk';
import ora from 'ora';
import fs from 'fs-extra';
import { queryTable, insertRow, getSchema } from '../lib/api-client.js';
import { getCurrentAppId } from '../lib/config.js';

async function requireAppId(appId?: string): Promise<string> {
  if (appId) return appId;
  const currentAppId = await getCurrentAppId();
  if (!currentAppId) {
    console.log(chalk.red('No app specified and no current app set'));
    console.log(chalk.gray('Use: butterbase apps use <app-id>'));
    process.exit(1);
  }
  return currentAppId;
}

function formatTable(rows: Record<string, unknown>[]) {
  if (rows.length === 0) {
    console.log(chalk.yellow('(0 rows)'));
    return;
  }

  const cols = Object.keys(rows[0]);
  const termWidth = process.stdout.columns || 120;

  // Calculate column widths
  const widths = cols.map((col) => {
    const maxVal = Math.max(...rows.map((r) => String(r[col] ?? '').length));
    return Math.min(Math.max(col.length, maxVal), 40);
  });

  // Truncate columns to fit terminal
  let totalWidth = widths.reduce((a, b) => a + b, 0) + (cols.length - 1) * 3;
  while (totalWidth > termWidth && widths.length > 1) {
    const lastIdx = widths.length - 1;
    const excess = totalWidth - termWidth;
    widths[lastIdx] = Math.max(4, widths[lastIdx] - excess);
    totalWidth = widths.reduce((a, b) => a + b, 0) + (cols.length - 1) * 3;
  }

  const pad = (val: string, w: number) => {
    if (val.length > w) return val.slice(0, w - 1) + '\u2026';
    return val.padEnd(w);
  };

  // Header
  console.log(chalk.gray(cols.map((c, i) => pad(c, widths[i])).join(' | ')));
  console.log(chalk.gray(widths.map((w) => '-'.repeat(w)).join('-+-')));

  // Rows
  for (const row of rows) {
    const line = cols.map((c, i) => pad(String(row[c] ?? ''), widths[i])).join(' | ');
    console.log(line);
  }

  console.log(chalk.gray(`\n(${rows.length} row${rows.length === 1 ? '' : 's'})`));
}

export async function dataQueryCommand(table: string, options: {
  app?: string; filter?: string[]; select?: string;
  order?: string; limit?: string; offset?: string; json?: boolean;
}) {
  const appId = await requireAppId(options.app);
  const spinner = ora(`Querying ${table}...`).start();

  try {
    const params: Record<string, string> = {};
    if (options.select) params.select = options.select;
    if (options.order) params.order = options.order;
    if (options.limit) params.limit = options.limit;
    if (options.offset) params.offset = options.offset;

    // Parse filters: --filter status=eq.active → params.status = 'eq.active'
    if (options.filter) {
      for (const f of options.filter) {
        const idx = f.indexOf('=');
        if (idx > 0) params[f.slice(0, idx)] = f.slice(idx + 1);
      }
    }

    const rows = await queryTable(appId, table, params);
    spinner.stop();

    if (options.json) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }

    formatTable(Array.isArray(rows) ? rows : []);
  } catch (error) {
    spinner.fail('Query failed');
    console.error(chalk.red((error as Error).message));
    process.exit(1);
  }
}

export async function dataInsertCommand(table: string, options: {
  app?: string; data?: string; file?: string; json?: boolean;
}) {
  const appId = await requireAppId(options.app);

  let rowData: Record<string, unknown>;

  if (options.data) {
    try { rowData = JSON.parse(options.data); }
    catch { console.error(chalk.red('Invalid JSON in --data')); process.exit(1); }
  } else if (options.file) {
    if (!await fs.pathExists(options.file)) {
      console.error(chalk.red(`File not found: ${options.file}`));
      process.exit(1);
    }
    const content = await fs.readFile(options.file, 'utf-8');
    try { rowData = JSON.parse(content); }
    catch { console.error(chalk.red('Invalid JSON in file')); process.exit(1); }
  } else {
    console.error(chalk.red('Provide --data or --file'));
    console.log(chalk.gray('Example: butterbase data insert posts --data \'{"title":"Hello"}\''));
    process.exit(1);
  }

  const spinner = ora(`Inserting into ${table}...`).start();

  try {
    const result = await insertRow(appId, table, rowData!);
    spinner.succeed(`Row inserted into "${table}"`);

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log('');
    for (const [key, val] of Object.entries(result)) {
      console.log(`  ${chalk.gray(key)}: ${val}`);
    }
  } catch (error) {
    spinner.fail('Insert failed');
    console.error(chalk.red((error as Error).message));
    process.exit(1);
  }
}
