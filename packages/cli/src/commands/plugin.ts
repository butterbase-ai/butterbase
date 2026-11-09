import { text } from '../lib/i18n.js';
import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import { getMergedConfig } from '../lib/config.js';

export async function pluginSetupCommand() {
  const config = await getMergedConfig();
  const apiUrl = config.endpoint || 'https://api.butterbase.ai';
  const mcpJsonPath = path.join(process.cwd(), '.mcp.json');

  if (await fs.pathExists(mcpJsonPath)) {
    console.log(chalk.yellow(text('\u26a0 .mcp.json already exists. Skipping.')));
    console.log(chalk.gray(text('  Delete it and re-run to regenerate.')));
    return;
  }

  const mcpConfig = {
    mcpServers: {
      butterbase: {
        url: `${apiUrl}/mcp`,
        headers: {
          Authorization: 'Bearer ${BUTTERBASE_API_KEY}',
        },
      },
    },
  };

  await fs.writeJson(mcpJsonPath, mcpConfig, { spaces: 2 });

  console.log(chalk.green(text('\u2713 Created .mcp.json')));
  console.log();
  console.log(chalk.white(text('Next steps:')));
  console.log(chalk.gray(text('  1. Set your API key:')));
  console.log(chalk.white('     export BUTTERBASE_API_KEY=bb_sk_your_key_here'));
  console.log(chalk.gray(text('  2. Install Butterbase Skills (optional \u2014 for guided skills):')));
  console.log(chalk.white('     claude plugin marketplace add https://github.com/butterbase-ai/butterbase-skills'));
  console.log(chalk.white('     claude plugin install butterbase-skills@butterbase-skills'));
  console.log(chalk.gray(text('  3. Start Claude Code in this directory')));
}
