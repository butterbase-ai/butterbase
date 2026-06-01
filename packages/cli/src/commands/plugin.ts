import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import { getMergedConfig } from '../lib/config.js';

export async function pluginSetupCommand() {
  const config = await getMergedConfig();
  const apiUrl = config.endpoint || 'https://api.butterbase.ai';
  const mcpJsonPath = path.join(process.cwd(), '.mcp.json');

  if (await fs.pathExists(mcpJsonPath)) {
    console.log(chalk.yellow('\u26a0 .mcp.json already exists. Skipping.'));
    console.log(chalk.gray('  Delete it and re-run to regenerate.'));
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

  console.log(chalk.green('\u2713 Created .mcp.json'));
  console.log();
  console.log(chalk.white('Next steps:'));
  console.log(chalk.gray('  1. Set your API key:'));
  console.log(chalk.white('     export BUTTERBASE_API_KEY=bb_sk_your_key_here'));
  console.log(chalk.gray('  2. Install Butterbase Skills (optional \u2014 for guided skills):'));
  console.log(chalk.white('     claude plugin add @butterbase/skills'));
  console.log(chalk.gray('  3. Start Claude Code in this directory'));
}
