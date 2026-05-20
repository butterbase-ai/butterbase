import chalk from 'chalk';
import ora from 'ora';
import prompts from 'prompts';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { getMergedConfig } from '../lib/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Resolve package root whether running from src/ (tsx) or dist/ (published). */
function getCliPackageRoot(): string {
  let dir = __dirname;
  for (;;) {
    const pkgJson = path.join(dir, 'package.json');
    const templatesDir = path.join(dir, 'templates');
    if (fs.existsSync(pkgJson) && fs.existsSync(templatesDir)) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error('Could not locate CLI package root (templates directory missing)');
    }
    dir = parent;
  }
}

interface TemplateVariables {
  PROJECT_NAME: string;
  APP_ID: string;
  API_URL: string;
}

async function replaceVariables(content: string, variables: TemplateVariables): Promise<string> {
  let result = content;
  for (const [key, value] of Object.entries(variables)) {
    result = result.replace(new RegExp(`{{${key}}}`, 'g'), value);
  }
  return result;
}

async function copyTemplate(
  templateDir: string,
  targetDir: string,
  variables: TemplateVariables
): Promise<void> {
  const files = await fs.readdir(templateDir, { withFileTypes: true });

  for (const file of files) {
    const sourcePath = path.join(templateDir, file.name);
    const targetPath = path.join(targetDir, file.name);

    if (file.isDirectory()) {
      await fs.ensureDir(targetPath);
      await copyTemplate(sourcePath, targetPath, variables);
    } else {
      const content = await fs.readFile(sourcePath, 'utf-8');
      const processedContent = await replaceVariables(content, variables);
      await fs.writeFile(targetPath, processedContent);
    }
  }
}

export async function initCommand(template?: string) {
  console.log(chalk.blue('🚀 Initialize Butterbase Project\n'));

  // Get project name
  const { projectName } = await prompts({
    type: 'text',
    name: 'projectName',
    message: 'Project name:',
    initial: 'my-butterbase-app',
    validate: (value) => value.length > 0 || 'Project name is required',
  });

  if (!projectName) {
    console.log(chalk.yellow('Cancelled'));
    process.exit(0);
  }

  // Select template
  if (!template) {
    const { selectedTemplate } = await prompts({
      type: 'select',
      name: 'selectedTemplate',
      message: 'Select a template:',
      choices: [
        { title: 'React + Vite', value: 'react-vite' },
        { title: 'Next.js (coming soon)', value: 'nextjs', disabled: true },
        { title: 'Vue + Vite (coming soon)', value: 'vue-vite', disabled: true },
      ],
    });

    if (!selectedTemplate) {
      console.log(chalk.yellow('Cancelled'));
      process.exit(0);
    }

    template = selectedTemplate;
  }

  // Get Butterbase configuration
  const config = await getMergedConfig();

  const { appId } = await prompts({
    type: 'text',
    name: 'appId',
    message: 'Butterbase App ID (leave empty to create later):',
    initial: config.currentApp || '',
  });

  const apiUrl = config.endpoint || 'https://api.butterbase.ai';

  // Create project directory
  const targetDir = path.join(process.cwd(), projectName);

  if (await fs.pathExists(targetDir)) {
    console.log(chalk.red(`✗ Directory "${projectName}" already exists`));
    process.exit(1);
  }

  const spinner = ora('Creating project...').start();

  try {
    // Get template directory
    const templateDir = path.join(getCliPackageRoot(), 'templates', template!);

    if (!await fs.pathExists(templateDir)) {
      throw new Error(`Template "${template}" not found`);
    }

    // Create target directory
    await fs.ensureDir(targetDir);

    // Copy template with variable replacement
    const variables: TemplateVariables = {
      PROJECT_NAME: projectName,
      APP_ID: appId || 'your-app-id',
      API_URL: apiUrl,
    };

    await copyTemplate(templateDir, targetDir, variables);

    // Create .env from .env.example
    const envExamplePath = path.join(targetDir, '.env.example');
    const envPath = path.join(targetDir, '.env');
    if (await fs.pathExists(envExamplePath)) {
      await fs.copy(envExamplePath, envPath);
    }

    spinner.succeed('Project created!');

    console.log(chalk.green('\n✓ Project initialized successfully!\n'));
    console.log(chalk.gray('Next steps:\n'));
    console.log(chalk.white(`  cd ${projectName}`));
    console.log(chalk.white(`  npm install`));
    console.log(chalk.white(`  npm run dev`));

    console.log(chalk.cyan('\n\ud83e\udd16 AI Agent Integration:'));
    console.log(chalk.white('  .mcp.json has been created for Claude Code / MCP integration.'));
    console.log(chalk.gray('  Set your API key: ') + chalk.white('export BUTTERBASE_API_KEY=bb_sk_...'));
    console.log(chalk.gray('  Install skills:   ') + chalk.white('claude plugin add @butterbase/plugin'));

    if (!appId) {
      console.log(chalk.yellow('\n⚠ Remember to update .env with your Butterbase App ID'));
    }
  } catch (error) {
    spinner.fail('Failed to create project');
    console.error(chalk.red((error as Error).message));
    process.exit(1);
  }
}
