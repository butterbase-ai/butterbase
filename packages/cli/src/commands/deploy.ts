import chalk from 'chalk';
import ora from 'ora';
import fs from 'fs-extra';
import path from 'path';
import AdmZip from 'adm-zip';
import { createDeployment, uploadBinary, startDeployment, getDeployment } from '../lib/api-client.js';
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

function detectDirectory(): string | null {
  for (const dir of ['dist', 'build', 'out', '.']) {
    if (fs.existsSync(path.join(dir, 'index.html'))) return dir;
  }
  return null;
}

function detectFramework(): string {
  if (fs.existsSync('vite.config.ts') || fs.existsSync('vite.config.js')) return 'react-vite';
  if (fs.existsSync('next.config.js') || fs.existsSync('next.config.mjs') || fs.existsSync('next.config.ts')) return 'nextjs-static';
  return 'static';
}

function zipDirectory(dir: string): Buffer {
  const zip = new AdmZip();
  const absDir = path.resolve(dir);

  function addDir(currentDir: string, zipPath: string) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const entryZipPath = zipPath ? `${zipPath}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        addDir(fullPath, entryZipPath);
      } else {
        zip.addFile(entryZipPath, fs.readFileSync(fullPath));
      }
    }
  }

  addDir(absDir, '');
  return zip.toBuffer();
}

export async function deployCommand(directory: string | undefined, options: {
  app?: string; framework?: string; json?: boolean;
}) {
  const appId = await requireAppId(options.app);

  // Resolve directory
  const dir = directory || detectDirectory();
  if (!dir) {
    console.error(chalk.red('Could not find a build directory (dist/, build/, out/)'));
    console.log(chalk.gray('Specify the directory: butterbase deploy ./dist'));
    process.exit(1);
  }

  if (!fs.existsSync(dir)) {
    console.error(chalk.red(`Directory not found: ${dir}`));
    process.exit(1);
  }

  if (!fs.existsSync(path.join(dir, 'index.html'))) {
    console.error(chalk.red(`No index.html found in ${dir}`));
    process.exit(1);
  }

  const framework = options.framework || detectFramework();
  const spinner = ora('Creating deployment...').start();

  try {
    // Step 1: Create deployment
    const deployment = await createDeployment(appId, framework);

    // Step 2: Zip directory
    spinner.text = 'Zipping build directory...';
    const zipBuffer = zipDirectory(dir);

    // Step 3: Upload
    spinner.text = 'Uploading...';
    await uploadBinary(deployment.uploadUrl, zipBuffer, 'application/zip');

    // Step 4: Start deployment
    spinner.text = 'Deploying...';
    await startDeployment(appId, deployment.id);

    // Step 5: Poll until done
    let status = 'BUILDING';
    let url = '';
    let fileCount = 0;
    let totalSize = 0;
    let attempts = 0;

    while (['BUILDING', 'UPLOADING', 'WAITING'].includes(status) && attempts < 60) {
      await new Promise((r) => setTimeout(r, 5000));
      spinner.text = `Deploying... (${attempts * 5}s)`;

      const result = await getDeployment(appId, deployment.id);
      status = result.status;
      url = result.url;
      fileCount = result.fileCount;
      totalSize = result.totalSizeBytes;
      attempts++;
    }

    if (status === 'READY') {
      spinner.succeed('Deployed!');

      if (options.json) {
        console.log(JSON.stringify({ url, deploymentId: deployment.id, status, framework, fileCount, totalSizeBytes: totalSize }, null, 2));
        return;
      }

      console.log('');
      console.log(`  URL:       ${chalk.green(url)}`);
      console.log(`  Framework: ${framework}`);
      if (fileCount) console.log(`  Files:     ${fileCount}`);
      if (totalSize) console.log(`  Size:      ${(totalSize / 1024 / 1024).toFixed(1)} MB`);
    } else if (status === 'ERROR') {
      spinner.fail('Deployment failed');
      const result = await getDeployment(appId, deployment.id);
      console.error(chalk.red(result.error || 'Unknown error'));
      process.exit(1);
    } else {
      spinner.warn(`Deployment timed out (status: ${status})`);
      console.log(chalk.gray(`Check status: butterbase status --app ${appId}`));
    }
  } catch (error) {
    spinner.fail('Deployment failed');
    console.error(chalk.red((error as Error).message));
    process.exit(1);
  }
}
