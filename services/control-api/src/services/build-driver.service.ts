// services/control-api/src/services/build-driver.service.ts
//
// Drives a server-side build through the build-runner Worker, owns the SSE
// log fanout, and on success hands the artifact off to the existing CF deploy
// code path.

import type { Pool } from 'pg';
import { config } from '../config.js';
import { buildKeys, getObjectAsBuffer } from './r2.js';
import * as EdgeSsrDeploymentService from './edge-ssr-deployment.service.js';
import * as DeploymentService from './deployment.service.js';
import { decrypt } from './crypto.js';

/**
 * Fetches and decrypts all env vars stored for an app in app_frontend_env_vars.
 * Returns a Record keyed by the var name. Throws if any value cannot be decrypted.
 */
export async function loadAppEnvVars(pool: Pool, appId: string): Promise<Record<string, string>> {
  const result = await pool.query<{ key: string; encrypted_value: string }>(
    `SELECT key, encrypted_value FROM app_frontend_env_vars WHERE app_id = $1`,
    [appId],
  );
  const encKey = process.env.AUTH_ENCRYPTION_KEY!;
  const env: Record<string, string> = {};
  for (const row of result.rows) {
    env[row.key] = decrypt(row.encrypted_value, encKey);
  }
  return env;
}

export type DeployType = 'edge_ssr' | 'frontend';

export interface StartBuildArgs {
  buildId: string;
  deploymentId: string;
  appId: string;
  deployType: DeployType;
  buildCommand: string;
  outputDir: string;
  packageManager: 'npm' | 'pnpm' | 'yarn';
  lockfileHash: string;
  userEnv: Record<string, string>;
}

export interface Subscriber {
  write(chunk: Buffer): void;
  end(): void;
}

export class BuildHandle {
  buffer: Buffer[] = [];
  subscribers: Set<Subscriber> = new Set();
  done = false;
  exitCode: number | null = null;
  failureReason: string | null = null;
  totalBytes = 0;
  constructor(public readonly buildId: string) {}

  push(chunk: Buffer): void {
    this.buffer.push(chunk);
    this.totalBytes += chunk.length;
    for (const s of this.subscribers) {
      try {
        s.write(chunk);
      } catch {
        // best-effort fanout — a broken subscriber must not stop the build
      }
    }
  }

  finish(exitCode: number, failureReason: string | null): void {
    this.done = true;
    this.exitCode = exitCode;
    this.failureReason = failureReason;
    for (const s of this.subscribers) {
      try {
        s.end();
      } catch {
        // best-effort
      }
    }
    this.subscribers.clear();
  }

  subscribe(s: Subscriber): void {
    for (const c of this.buffer) {
      try {
        s.write(c);
      } catch {
        // best-effort replay
      }
    }
    if (this.done) {
      try {
        s.end();
      } catch {
        // best-effort
      }
      return;
    }
    this.subscribers.add(s);
  }
}

const handles = new Map<string, BuildHandle>();

export function getHandle(buildId: string): BuildHandle | undefined {
  return handles.get(buildId);
}

export async function startBuild(pool: Pool, args: StartBuildArgs): Promise<BuildHandle> {
  if (handles.has(args.buildId)) {
    throw new Error(`build ${args.buildId} already running`);
  }
  const handle = new BuildHandle(args.buildId);
  handles.set(args.buildId, handle);

  await pool.query(
    `UPDATE app_build_jobs SET status = 'BUILDING', started_at = now() WHERE id = $1`,
    [args.buildId],
  );

  const keys = buildKeys(args.deploymentId, args.appId, args.lockfileHash);
  void runBuild(pool, args, keys, handle);
  return handle;
}

async function runBuild(
  pool: Pool,
  args: StartBuildArgs,
  keys: ReturnType<typeof buildKeys>,
  handle: BuildHandle,
): Promise<void> {
  let exitCode = 1;
  let failureReason: string | null = 'INTERNAL';
  try {
    const reqBody = {
      buildId: args.buildId,
      appId: args.appId,
      deployType: args.deployType,
      buildCommand: args.buildCommand,
      outputDir: args.outputDir,
      packageManager: args.packageManager,
      bucket: config.s3.bucket,
      sourceKey: keys.source,
      artifactKey: keys.artifact,
      logKey: keys.log,
      cacheKey: keys.cache,
      lockfileHash: args.lockfileHash,
      userEnv: args.userEnv,
    };
    const resp = await fetch(config.buildRunner.url, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${config.buildRunner.sharedSecret}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(reqBody),
    });
    if (!resp.ok) {
      handle.push(Buffer.from(`[driver] build runner returned ${resp.status}\n`));
      failureReason = 'INTERNAL';
      return;
    }
    if (!resp.body) {
      failureReason = 'INTERNAL';
      return;
    }
    const reader = resp.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      handle.push(Buffer.from(value));
    }

    try {
      const statusBuf = await getObjectAsBuffer(keys.status);
      const parsed = JSON.parse(statusBuf.toString('utf8'));
      exitCode = parsed.exit_code ?? 1;
      failureReason = parsed.failure_reason ?? null;
    } catch {
      exitCode = 1;
      failureReason = 'INTERNAL';
    }
  } catch (e: any) {
    handle.push(Buffer.from(`[driver] error: ${e?.message ?? String(e)}\n`));
  } finally {
    if (exitCode === 0 && !failureReason) {
      try {
        await pool.query(
          `UPDATE app_build_jobs SET status = 'DEPLOYING' WHERE id = $1`,
          [args.buildId],
        );
        const artifact = await getObjectAsBuffer(keys.artifact);
        if (args.deployType === 'edge_ssr') {
          await EdgeSsrDeploymentService.deployArtifact(pool, args.deploymentId, artifact);
        } else {
          await DeploymentService.deployArtifact(pool, args.deploymentId, artifact);
        }
        await pool.query(
          `UPDATE app_build_jobs
             SET status = 'READY', completed_at = now(), exit_code = 0
             WHERE id = $1`,
          [args.buildId],
        );
      } catch (e: any) {
        failureReason = 'DEPLOY_FAILED';
        exitCode = 1;
        await pool.query(
          `UPDATE app_build_jobs
             SET status = 'FAILED', completed_at = now(),
                 exit_code = $2, failure_reason = $3
             WHERE id = $1`,
          [args.buildId, 1, failureReason],
        ).catch(() => {});
        // deployArtifact already updated the deployment row to ERROR — nothing more to do here.
        handle.push(Buffer.from(`[driver] deploy failed: ${e?.message ?? String(e)}\n`));
      }
    } else {
      // Build failed before deploy: update app_build_jobs and also mark the deployment row
      // as ERROR so CLI callers polling the deployment GET endpoint see a terminal state.
      await pool.query(
        `UPDATE app_build_jobs
           SET status = 'FAILED', completed_at = now(),
               exit_code = $2, failure_reason = $3
           WHERE id = $1`,
        [args.buildId, exitCode, failureReason],
      ).catch(() => {});
      const errorMessage = failureReason ?? 'Build failed';
      if (args.deployType === 'edge_ssr') {
        await pool.query(
          `UPDATE app_edge_ssr_deployments
              SET status = 'ERROR', error_message = $2, updated_at = now()
            WHERE id = $1`,
          [args.deploymentId, errorMessage],
        ).catch(() => {});
      } else {
        await pool.query(
          `UPDATE app_deployments
              SET status = 'ERROR', error_message = $2, updated_at = now()
            WHERE id = $1`,
          [args.deploymentId, errorMessage],
        ).catch(() => {});
      }
    }
    handle.finish(exitCode, failureReason);
    setTimeout(() => handles.delete(args.buildId), 60_000);
  }
}
