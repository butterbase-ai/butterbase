// services/build-runner/src/worker.ts
import { Container } from '@cloudflare/containers';
import { checkAuth } from './auth.js';

export interface Env {
  BUILD_CONTAINER: DurableObjectNamespace<BuildContainer>;
  BUILD_RUNNER_SHARED_SECRET: string;
  R2_ENDPOINT: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
}

interface BuildRequest {
  buildId: string;
  appId: string;
  deployType: 'edge_ssr' | 'frontend';
  buildCommand: string;
  outputDir: string;
  packageManager: 'npm' | 'pnpm' | 'yarn';
  bucket: string;
  sourceKey: string;
  artifactKey: string;
  logKey: string;
  cacheKey: string;
  lockfileHash: string;
  userEnv: Record<string, string>;
}

export class BuildContainer extends Container<Env> {
  defaultPort = 8080;
  // Each build maps to a unique DO id (idFromName(buildId)) and the container
  // exits when the build completes. sleepAfter is a safety net for stuck runs.
  sleepAfter = '10m';

  override async fetch(req: Request): Promise<Response> {
    const body = await req.json<BuildRequest>();

    // startAndWaitForPorts polls the TCP port until it accepts connections,
    // closing the race between container.start() and the first containerFetch.
    // v1: long-lived R2 bucket credentials are forwarded to the container env;
    // v2 TODO will mint per-build session-scoped credentials instead.
    await this.startAndWaitForPorts({
      startOptions: {
        enableInternet: true,
        envVars: {
          BUILD_ID: body.buildId,
          APP_ID: body.appId,
          DEPLOY_TYPE: body.deployType,
          BUILD_COMMAND: body.buildCommand,
          OUTPUT_DIR: body.outputDir,
          PACKAGE_MANAGER: body.packageManager,
          R2_BUCKET: body.bucket,
          R2_SOURCE_KEY: body.sourceKey,
          R2_ARTIFACT_KEY: body.artifactKey,
          R2_LOG_KEY: body.logKey,
          R2_CACHE_KEY: body.cacheKey,
          LOCKFILE_HASH: body.lockfileHash,
          USER_ENV_JSON: JSON.stringify(body.userEnv ?? {}),
          R2_ENDPOINT: this.env.R2_ENDPOINT,
          R2_ACCESS_KEY_ID: this.env.R2_ACCESS_KEY_ID,
          R2_SECRET_ACCESS_KEY: this.env.R2_SECRET_ACCESS_KEY,
        },
      },
      ports: 8080,
      cancellationOptions: {
        instanceGetTimeoutMS: 15_000,
        portReadyTimeoutMS: 30_000,
        waitInterval: 250,
      },
    });

    return this.containerFetch('http://container/run', { method: 'POST' });
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const denied = checkAuth(req, env.BUILD_RUNNER_SHARED_SECRET);
    if (denied) return denied;
    const url = new URL(req.url);
    if (url.pathname !== '/build' || req.method !== 'POST') {
      return new Response('not found', { status: 404 });
    }
    const body = await req.text();
    let parsed: BuildRequest;
    try { parsed = JSON.parse(body); } catch { return new Response('bad json', { status: 400 }); }
    const id = env.BUILD_CONTAINER.idFromName(parsed.buildId);
    const stub = env.BUILD_CONTAINER.get(id);
    return stub.fetch(new Request(req.url, { method: 'POST', body, headers: { 'content-type': 'application/json' } }));
  },
};
