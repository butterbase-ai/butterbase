import chalk from 'chalk';
import ora from 'ora';
import fs from 'fs-extra';
import path from 'path';
import AdmZip from 'adm-zip';
import { getMergedConfig } from '../lib/config.js';
import { getCurrentAppId } from '../lib/config.js';
import { detectPackageManagerAndLockfile } from '../lib/lockfile-hash.js';
import { streamSSE } from '../lib/sse.js';

interface Options {
  app?: string;
  fromPath?: string;
  buildCommand?: string;
  outputDir?: string;
  framework?: string;
}

async function requireAppId(appId?: string): Promise<string> {
  if (appId) return appId;
  const currentAppId = await getCurrentAppId();
  if (!currentAppId) {
    console.error(chalk.red('No app specified and no current app set'));
    console.log(chalk.gray('Use: butterbase apps use <app-id>'));
    process.exit(1);
  }
  return currentAppId;
}

function zipDir(root: string, prefix: string, zip: AdmZip, exclude: string[]): void {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    if (exclude.includes(entry.name)) continue;
    const abs = path.join(root, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      zipDir(abs, rel, zip, exclude);
    } else {
      zip.addFile(rel, fs.readFileSync(abs));
    }
  }
}

export async function deployEdgeSsrFromSource(opts: Options): Promise<void> {
  const projectDir = path.resolve(opts.fromPath ?? process.cwd());

  if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
    console.error(chalk.red(`${projectDir} is not a directory`));
    process.exit(1);
  }

  const appId = await requireAppId(opts.app);
  const config = await getMergedConfig();
  const apiBase = config.endpoint;
  const apiKey = config.apiKey;

  if (!apiKey) {
    console.error(chalk.red('Not authenticated. Run: butterbase login'));
    process.exit(1);
  }

  const framework = opts.framework ?? 'nextjs-edge';
  const spinner = ora('Zipping source...').start();

  try {
    // 1. Zip the project
    const zip = new AdmZip();
    zipDir(projectDir, '', zip, ['node_modules', '.next', '.vercel', '.git']);
    const zipBuf = zip.toBuffer();

    if (zipBuf.length > 50 * 1024 * 1024) {
      spinner.fail('Source too large');
      console.error(chalk.red('Zipped source exceeds 50 MB limit'));
      process.exit(1);
    }

    // 2. Create deployment
    spinner.text = 'Creating deployment...';
    const createRes = await fetch(`${apiBase}/v1/${appId}/edge-ssr/deployments/from-source`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ framework }),
    });

    if (!createRes.ok) {
      const text = await createRes.text();
      throw new Error(`create failed: ${createRes.status} ${text}`);
    }

    const created = (await createRes.json()) as {
      deployment_id: string;
      build_id: string;
      upload_url: string;
      max_source_bytes: number;
    };

    // 3. Upload zip to presigned URL
    spinner.text = `Uploading source (${(zipBuf.length / 1024 / 1024).toFixed(1)} MB)...`;
    const putRes = await fetch(created.upload_url, {
      method: 'PUT',
      body: new Uint8Array(zipBuf),
      headers: { 'content-type': 'application/zip' },
    });

    if (!putRes.ok) {
      throw new Error(`upload failed: ${putRes.status}`);
    }

    // 4. Detect package manager + lockfile hash
    const { packageManager, lockfileHash } = detectPackageManagerAndLockfile(projectDir);

    // 5. Start build
    spinner.text = 'Starting build...';
    const startRes = await fetch(
      `${apiBase}/v1/${appId}/edge-ssr/deployments/from-source/${created.deployment_id}/start`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          buildCommand: opts.buildCommand ?? 'npx @cloudflare/next-on-pages',
          outputDir: opts.outputDir ?? '.vercel/output/static',
          packageManager,
          lockfileHash,
          userEnv: {},
        }),
      },
    );

    if (!startRes.ok) {
      const text = await startRes.text();
      throw new Error(`start failed: ${startRes.status} ${text}`);
    }

    spinner.succeed('Build started — streaming logs...');
    console.log('');

    // 6. Tail SSE logs
    await streamSSE(
      `${apiBase}/v1/${appId}/edge-ssr/deployments/from-source/${created.deployment_id}/logs`,
      { authorization: `Bearer ${apiKey}` },
    );

    // 7. Poll deployment status until terminal (READY / ERROR)
    const deadline = Date.now() + 30_000;
    let final: { status: string; url?: string; error?: string } | null = null;
    while (Date.now() < deadline) {
      const r = await fetch(`${apiBase}/v1/${appId}/edge-ssr/deployments/${created.deployment_id}`, {
        headers: { authorization: `Bearer ${apiKey}` },
      });
      if (r.ok) {
        final = (await r.json()) as { status: string; url?: string; error?: string };
        if (final && (final.status === 'READY' || final.status === 'ERROR' || final.status === 'FAILED')) break;
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }

    console.log('');
    if (!final || final.status !== 'READY') {
      process.stderr.write(
        `\n✗ Deploy failed: ${final?.status ?? 'unknown'}${final?.error ? ` (${final.error})` : ''}\n`,
      );
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`\n✓ Deployed: ${final.url}\n`);
  } catch (error) {
    spinner.fail('Deployment failed');
    console.error(chalk.red((error as Error).message));
    process.exit(1);
  }
}
