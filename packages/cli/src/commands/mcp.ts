import { spawn } from 'node:child_process';
import chalk from 'chalk';

const DEFAULT_MCP_URL = 'https://api.butterbase.ai/mcp';
const DEFAULT_SERVER_NAME = 'butterbase';
const DASHBOARD_URL = 'https://app.butterbase.ai';

interface McpInstallOptions {
  url?: string;
  name?: string;
  scope?: 'global' | 'local';
  clients?: string;
  yes?: boolean;
}

/**
 * Install the Butterbase MCP server into all detected AI clients via `add-mcp`,
 * then print a per-client "next steps" block tailored for the OAuth flow.
 *
 * Why a wrapper: `add-mcp` itself only mutates client config files — it does
 * not print install-time guidance, and the MCP authorization handshake (RFC
 * 9728 / OAuth 2.1) requires the user to take a per-client action to trigger
 * the browser. Each of the 14 supported clients has a different entry point.
 */
export async function mcpInstallCommand(options: McpInstallOptions): Promise<void> {
  const url = options.url ?? DEFAULT_MCP_URL;
  const name = options.name ?? DEFAULT_SERVER_NAME;
  const scope = options.scope ?? 'global';

  const args = ['--yes', 'add-mcp', '-n', name, url];
  if (scope === 'global') args.push('-g');
  if (options.clients && options.clients !== 'all') {
    args.push('-a', options.clients);
  } else {
    args.push('--all');
  }
  if (options.yes !== false) args.push('-y');

  console.log(chalk.dim(`Running: npx ${args.join(' ')}`));
  console.log();

  const exitCode = await runChild('npx', args);

  if (exitCode !== 0) {
    console.error(chalk.red(`\nadd-mcp exited with status ${exitCode}`));
    process.exit(exitCode ?? 1);
  }

  printNextSteps({ name, url });
}

function runChild(cmd: string, args: string[]): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'inherit' });
    child.on('close', (code) => resolve(code));
    child.on('error', (err) => {
      console.error(chalk.red(`Failed to spawn ${cmd}: ${err.message}`));
      resolve(1);
    });
  });
}

function printNextSteps({ name, url }: { name: string; url: string }): void {
  const isLocal = /localhost|127\.0\.0\.1/.test(url);
  const consentUrl = isLocal
    ? url.replace(/\/mcp$/, '').replace(/:\d+$/, ':3000') + '/oauth/consent'
    : `${DASHBOARD_URL}/oauth/consent`;

  console.log();
  console.log(chalk.bold.green('  Butterbase MCP installed.'));
  console.log(
    chalk.dim(`  Server: ${name}  •  URL: ${url}`),
  );
  console.log();
  console.log(chalk.bold('  Next: each client needs a one-time browser sign-in.'));
  console.log();

  const rows: Array<[string, string]> = [
    ['Claude Code',     `restart, then run /mcp  (or: claude mcp login ${name})`],
    ['Cursor',          `Settings → MCP → toggle ${chalk.cyan(name)} → click "Needs Login"`],
    ['VS Code',         `⌘⇧P → "MCP: List Servers" → ${chalk.cyan(name)} → Authenticate`],
    ['Visual Studio',   `Open .mcp.json → click the CodeLens "Auth" link above ${chalk.cyan(name)}`],
    ['JetBrains/Xcode/Eclipse', 'Approve the "wants to authenticate" popup on next chat'],
    ['Codex / Gemini CLI',  'Open a new session, invoke any butterbase_* tool — browser opens automatically'],
    ['Cline / Goose / Copilot CLI', 'Same as Codex — first tool call triggers the OAuth flow'],
    ['OpenCode / Windsurf / Zed / Antigravity', 'Same — invoke any butterbase_* tool to trigger auth'],
  ];

  const labelWidth = Math.max(...rows.map(([l]) => l.length));
  for (const [label, hint] of rows) {
    console.log(`  ${chalk.cyan(label.padEnd(labelWidth))}  ${hint}`);
  }

  console.log();
  console.log(chalk.dim(`  Consent URL (opens automatically): ${consentUrl}`));
  console.log(chalk.dim(`  Troubleshooting: https://docs.butterbase.ai/mcp/auth`));
  console.log();
}
