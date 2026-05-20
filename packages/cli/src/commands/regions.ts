import chalk from 'chalk';
import { listRegions } from '../lib/api-client.js';

export async function regionsListCommand(options: { json?: boolean }) {
  try {
    const r: any = await listRegions();
    if (options.json) return console.log(JSON.stringify(r, null, 2));
    for (const reg of r.regions ?? []) console.log(reg);
  } catch (e) {
    console.error(chalk.red((e as Error).message));
    process.exit(1);
  }
}
