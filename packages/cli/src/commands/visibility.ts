// submodules/butterbase-oss/packages/cli/src/commands/visibility.ts
import chalk from 'chalk';
import { setAppVisibility } from '../lib/api-client.js';
import { getCurrentAppId } from '../lib/config.js';

export async function visibilityCommand(
  mode: 'public' | 'private',
  opts: { app?: string; listed?: boolean; unlisted?: boolean; json?: boolean }
) {
  const appId = opts.app ?? (await getCurrentAppId());
  if (!appId) {
    console.log(chalk.red('✗ no app — use `butterbase apps use <id>` or --app'));
    process.exit(1);
  }
  if (mode !== 'public' && mode !== 'private') {
    console.log(chalk.red(`✗ visibility must be "public" or "private" (got ${mode})`));
    process.exit(1);
  }
  if (opts.listed && opts.unlisted) {
    console.log(chalk.red('✗ --listed and --unlisted are mutually exclusive'));
    process.exit(1);
  }
  const body: { visibility: 'public' | 'private'; listed?: boolean } = { visibility: mode };
  if (opts.listed) body.listed = true;
  if (opts.unlisted) body.listed = false;

  const res = await setAppVisibility(appId!, body);
  if (opts.json) {
    console.log(JSON.stringify(res, null, 2));
  } else {
    console.log(chalk.green(`✓ ${appId} is now ${mode}${body.listed === false ? ' (unlisted)' : ''}`));
  }
}
