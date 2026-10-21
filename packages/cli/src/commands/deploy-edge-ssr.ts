import { text, msg } from '../lib/i18n.js';
import chalk from 'chalk';
import ora from 'ora';
import fs from 'fs-extra';
import path from 'path';
import AdmZip from 'adm-zip';
import { createEdgeSsrDeployment, uploadBinary, startEdgeSsrDeployment, getEdgeSsrDeployment } from '../lib/api-client.js';
import { getCurrentAppId } from '../lib/config.js';

const WORKER_JS = '_worker.js';
const WORKER_JS_INDEX = path.join('_worker.js', 'index.js');
const DEFAULT_VERCEL_OUTPUT = path.join('.vercel', 'output', 'static');

const MISSING_WORKER_MESSAGE =
  'No _worker.js found. Run `npx @cloudflare/next-on-pages` to build, or use `--from <path>` to point at the directory containing _worker.js.';

async function requireAppId(appId?: string): Promise<string> {
  if (appId) return appId;
  const currentAppId = await getCurrentAppId();
  if (!currentAppId) {
    console.error(chalk.red(text('No app specified and no current app set')));
    console.log(chalk.gray(text('Use: butterbase apps use <app-id>')));
    process.exit(1);
  }
  return currentAppId;
}

function hasWorkerJs(dir: string): boolean {
  return (
    fs.existsSync(path.join(dir, WORKER_JS)) ||
    fs.existsSync(path.join(dir, WORKER_JS_INDEX))
  );
}

function detectEdgeSsrDirectory(): string | null {
  // 1. Prefer .vercel/output/static/ if it contains _worker.js
  if (fs.existsSync(DEFAULT_VERCEL_OUTPUT) && hasWorkerJs(DEFAULT_VERCEL_OUTPUT)) {
    return DEFAULT_VERCEL_OUTPUT;
  }
  // 2. Fall back to cwd if it contains _worker.js
  if (hasWorkerJs('.')) {
    return '.';
  }
  return null;
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

export async function deployEdgeSsrCommand(
  directory: string | undefined,
  options: { app?: string; framework?: string; from?: string; json?: boolean },
) {
  const appId = await requireAppId(options.app);

  // Resolve the source directory: explicit positional > --from > auto-detect
  const resolvedDir = directory ?? options.from ?? detectEdgeSsrDirectory();

  if (!resolvedDir) {
    console.error(chalk.red(text(MISSING_WORKER_MESSAGE)));
    process.exit(1);
  }

  // Pre-upload validation: directory must exist
  if (!fs.existsSync(resolvedDir)) {
    console.error(chalk.red(msg`Directory not found: ${resolvedDir}`));
    process.exit(1);
  }

  // Pre-upload validation: must contain _worker.js (file or _worker.js/index.js)
  if (!hasWorkerJs(resolvedDir)) {
    console.error(chalk.red(text(MISSING_WORKER_MESSAGE)));
    console.error(chalk.gray(msg`Checked: ${path.resolve(resolvedDir)}`));
    process.exit(1);
  }

  const framework = options.framework ?? 'nextjs-edge';
  const spinner = ora(text('Creating Edge SSR deployment...')).start();

  try {
    // Step 1: Create deployment (get upload URL)
    const deployment = await createEdgeSsrDeployment(appId, framework);

    // Step 2: Zip the directory
    spinner.text = text('Zipping build directory...');
    const zipBuffer = zipDirectory(resolvedDir);

    // Step 3: Upload zip to presigned URL
    spinner.text = text('Uploading...');
    await uploadBinary(deployment.uploadUrl, zipBuffer, 'application/zip');

    // Step 4: Start the deployment pipeline
    spinner.text = text('Deploying...');
    await startEdgeSsrDeployment(appId, deployment.id);

    // Step 5: Poll until terminal state (5 s × 60 = 5 min max)
    let status = 'BUILDING';
    let url = '';
    let fileCount = 0;
    let totalSize = 0;
    let attempts = 0;

    while (['BUILDING', 'UPLOADING', 'WAITING'].includes(status) && attempts < 60) {
      await new Promise((r) => setTimeout(r, 5000));
      spinner.text = msg`Deploying... (${attempts * 5}s)`;

      const result = await getEdgeSsrDeployment(appId, deployment.id);
      status = result.status;
      url = result.url;
      fileCount = result.fileCount;
      totalSize = result.totalSizeBytes;
      attempts++;
    }

    if (status === 'READY') {
      spinner.succeed(text('Deployed!'));

      if (options.json) {
        console.log(
          JSON.stringify(
            { url, deploymentId: deployment.id, status, framework, fileCount, totalSizeBytes: totalSize },
            null,
            2,
          ),
        );
        return;
      }

      console.log('');
      console.log(msg`  URL:       ${chalk.green(url)}`);
      console.log(msg`  Framework: ${framework}`);
      if (fileCount) console.log(msg`  Files:     ${fileCount}`);
      if (totalSize) console.log(msg`  Size:      ${(totalSize / 1024 / 1024).toFixed(1)} MB`);
    } else if (status === 'ERROR') {
      spinner.fail(text('Deployment failed'));
      const result = await getEdgeSsrDeployment(appId, deployment.id);
      console.error(chalk.red(result.error ?? text('Unknown error')));
      process.exit(1);
    } else if (status === 'CANCELED' || status === 'SUPERSEDED') {
      spinner.warn(msg`Deployment ${status.toLowerCase()} (id: ${deployment.id})`);
    } else {
      // Timeout — attempts exhausted while still in a transient state
      spinner.warn(msg`Deployment timed out (status: ${status})`);
      console.log(chalk.gray(msg`Check status: butterbase status --app ${appId}`));
    }
  } catch (error) {
    spinner.fail(text('Deployment failed'));
    console.error(chalk.red((error as Error).message));
    process.exit(1);
  }
}
