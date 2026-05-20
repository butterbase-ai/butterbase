import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import AdmZip from 'adm-zip';

const HAS_ENV = !!(process.env.CONTROL_API_URL && process.env.BB_API_KEY && process.env.BB_APP_ID);

if (!HAS_ENV) {
  // eslint-disable-next-line no-console
  console.log(
    '[build-runner e2e] Skipping: set CONTROL_API_URL, BB_API_KEY, and BB_APP_ID to run.',
  );
}

describe.runIf(HAS_ENV)('e2e: server-side build → deploy', () => {
  it(
    'builds the fixture, deploys it, and serves SSR HTML',
    async () => {
      const apiBase = process.env.CONTROL_API_URL!.replace(/\/$/, '');
      const apiKey = process.env.BB_API_KEY!;
      const appId = process.env.BB_APP_ID!;
      const fixtureDir = path.resolve(__dirname, 'e2e.fixture');

      // 1. Zip fixture
      const zip = new AdmZip();
      zipDir(fixtureDir, '', zip, ['node_modules', '.next', '.vercel', '.git']);
      const zipBuf = zip.toBuffer();

      // 2. Create from-source deployment
      const create = await fetch(
        `${apiBase}/v1/${appId}/edge-ssr/deployments/from-source`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ framework: 'nextjs-edge' }),
        },
      );
      expect(create.ok, await create.clone().text()).toBe(true);
      const created = (await create.json()) as {
        deployment_id: string;
        build_id: string;
        upload_url: string;
      };

      // 3. Upload zip to presigned URL
      const put = await fetch(created.upload_url, {
        method: 'PUT',
        body: zipBuf,
        headers: { 'content-type': 'application/zip' },
      });
      expect(put.ok).toBe(true);

      // 4. Start build
      const lockfileHash = createHash('sha256')
        .update(readFileSync(path.join(fixtureDir, 'package-lock.json')))
        .digest('hex')
        .slice(0, 32);
      const start = await fetch(
        `${apiBase}/v1/${appId}/edge-ssr/deployments/from-source/${created.deployment_id}/start`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            buildCommand: 'npx @cloudflare/next-on-pages',
            outputDir: '.vercel/output/static',
            packageManager: 'npm',
            lockfileHash,
            userEnv: {},
          }),
        },
      );
      expect(start.ok, await start.clone().text()).toBe(true);

      // 5. Subscribe to SSE logs and assert at least one chunk arrives
      let sawChunk = false;
      await new Promise<void>((resolve, reject) => {
        const u = new URL(
          `${apiBase}/v1/${appId}/edge-ssr/deployments/from-source/${created.deployment_id}/logs`,
        );
        const lib =
          u.protocol === 'https:'
            ? // eslint-disable-next-line @typescript-eslint/no-require-imports
              require('node:https')
            : // eslint-disable-next-line @typescript-eslint/no-require-imports
              require('node:http');
        const req = lib.request(
          {
            method: 'GET',
            hostname: u.hostname,
            port: u.port,
            path: u.pathname + u.search,
            headers: {
              accept: 'text/event-stream',
              authorization: `Bearer ${apiKey}`,
            },
          },
          (res: { statusCode: number; on: (e: string, cb: (...a: unknown[]) => void) => void }) => {
            if (res.statusCode >= 400) {
              reject(new Error(`logs ${res.statusCode}`));
              return;
            }
            res.on('data', () => {
              sawChunk = true;
            });
            res.on('end', () => resolve());
            res.on('error', reject);
          },
        );
        req.on('error', reject);
        req.end();
        // Cap log subscription at 6 minutes so the test never hangs.
        setTimeout(
          () => {
            try {
              req.destroy();
            } catch {
              /* ignore */
            }
            resolve();
          },
          6 * 60 * 1000,
        );
      });
      expect(sawChunk).toBe(true);

      // 6. Poll deployment status. The GET /v1/:appId/edge-ssr/deployments/:id
      //    route returns { status, url, error, ... } — see services/control-api
      //    src/routes/edge-ssr.ts.
      let status = 'PENDING';
      let deployedUrl: string | undefined;
      const deadline = Date.now() + 6 * 60 * 1000;
      while (Date.now() < deadline) {
        const r = await fetch(
          `${apiBase}/v1/${appId}/edge-ssr/deployments/${created.deployment_id}`,
          { headers: { authorization: `Bearer ${apiKey}` } },
        );
        if (r.ok) {
          const j = (await r.json()) as { status: string; url?: string };
          status = j.status;
          deployedUrl = j.url;
          if (status === 'READY' || status === 'FAILED') break;
        }
        await new Promise((r) => setTimeout(r, 5_000));
      }

      expect(status).toBe('READY');

      // 7. Hit the deployed URL — server-rendered fixture should respond "ok".
      if (deployedUrl) {
        const fetchDeployed = await fetch(deployedUrl);
        expect(fetchDeployed.ok).toBe(true);
        const body = await fetchDeployed.text();
        expect(body).toContain('ok');
      }
    },
    10 * 60 * 1000,
  );
});

function zipDir(root: string, prefix: string, zip: AdmZip, exclude: string[]) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
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
