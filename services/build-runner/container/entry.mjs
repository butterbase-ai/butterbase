// services/build-runner/container/entry.mjs
// Build container entrypoint. Configured via env vars (set by the build-runner
// Worker). Runs an HTTP server on PORT (default 8080) so the Worker can proxy
// build invocations via container.fetch(). The server has one route:
//   POST /run -> kicks off the build pipeline; streams combined stdout/stderr
//                into the response body; closes when the build finishes.
// On completion the container exits (with a 1s grace period so CF can flush
// the trailing response bytes back to the Worker).
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync, readdirSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import * as tar from 'tar';
import { makeClient, downloadToFile, exists as r2Exists, head, uploadFile, uploadBuffer } from './r2.mjs';

const LOG_FLUSH_MS = 2000;
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const ARTIFACT_MAX_BYTES = 25 * 1024 * 1024;
const PORT = parseInt(process.env.PORT ?? '8080', 10);

function readEnv() {
  const required = [
    'BUILD_ID', 'APP_ID', 'DEPLOY_TYPE',
    'BUILD_COMMAND', 'OUTPUT_DIR', 'PACKAGE_MANAGER',
    'R2_BUCKET', 'R2_SOURCE_KEY', 'R2_ARTIFACT_KEY', 'R2_LOG_KEY', 'R2_CACHE_KEY',
    'LOCKFILE_HASH',
  ];
  for (const k of required) {
    if (!process.env[k]) throw new Error(`Missing required env var: ${k}`);
  }
  let userEnv = {};
  if (process.env.USER_ENV_JSON) userEnv = JSON.parse(process.env.USER_ENV_JSON);
  return {
    buildId: process.env.BUILD_ID,
    appId: process.env.APP_ID,
    deployType: process.env.DEPLOY_TYPE,
    buildCommand: process.env.BUILD_COMMAND,
    outputDir: process.env.OUTPUT_DIR,
    packageManager: process.env.PACKAGE_MANAGER,
    bucket: process.env.R2_BUCKET,
    sourceKey: process.env.R2_SOURCE_KEY,
    artifactKey: process.env.R2_ARTIFACT_KEY,
    logKey: process.env.R2_LOG_KEY,
    cacheKey: process.env.R2_CACHE_KEY,
    lockfileHash: process.env.LOCKFILE_HASH,
    userEnv,
  };
}

class LogBuffer {
  constructor() {
    this.chunks = [];
    this.size = 0;
    this.truncated = false;
  }
  append(chunk) {
    if (this.truncated) return;
    if (this.size + chunk.length > LOG_MAX_BYTES) {
      const room = LOG_MAX_BYTES - this.size;
      if (room > 0) this.chunks.push(chunk.subarray(0, room));
      this.chunks.push(Buffer.from('\n[log truncated at 5 MB]\n'));
      this.truncated = true;
      return;
    }
    this.chunks.push(chunk);
    this.size += chunk.length;
  }
  toBuffer() { return Buffer.concat(this.chunks); }
}

// Append a chunk to the log buffer AND forward it to the streaming response.
// `sink` may be null (e.g. early-fatal path before the response stream is set).
function emit(log, sink, chunk) {
  log.append(chunk);
  if (sink && !sink.writableEnded) {
    try { sink.write(chunk); } catch { /* ignore broken pipe */ }
  }
}

function tee(child, log, sink) {
  const onChunk = (buf) => emit(log, sink, buf);
  child.stdout.on('data', onChunk);
  child.stderr.on('data', onChunk);
}

function exec(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    tee(child, opts.log, opts.sink);
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 0));
  });
}

async function flushLog(client, env, log) {
  await uploadBuffer(client, env.bucket, env.logKey, log.toBuffer(), 'text/plain; charset=utf-8');
}

async function runBuild(sink) {
  const env = readEnv();
  const client = makeClient();
  const log = new LogBuffer();

  let timer;
  const startTimer = () => { timer = setInterval(() => flushLog(client, env, log).catch(() => {}), LOG_FLUSH_MS); };
  const stopTimer = () => { if (timer) clearInterval(timer); };

  const work = mkdtempSync(path.join(tmpdir(), 'bb-build-'));
  const sourceZip = path.join(work, 'source.zip');
  const projectDir = path.join(work, 'project');
  mkdirSync(projectDir, { recursive: true });

  let exitCode = 0;
  let failureReason = null;
  let outputDirSize = 0;
  startTimer();
  try {
    // 1. Download source
    emit(log, sink, Buffer.from(`[runner] downloading source ${env.sourceKey}\n`));
    const SOURCE_MAX_BYTES = 50 * 1024 * 1024;
    const sourceMeta = await head(client, env.bucket, env.sourceKey);
    if (!sourceMeta.exists) {
      failureReason = 'INTERNAL';
      throw new Error(`source ${env.sourceKey} not found in R2`);
    }
    if (sourceMeta.contentLength > SOURCE_MAX_BYTES) {
      failureReason = 'SOURCE_TOO_LARGE';
      throw new Error(`source ${sourceMeta.contentLength} > ${SOURCE_MAX_BYTES}`);
    }
    await downloadToFile(client, env.bucket, env.sourceKey, sourceZip);
    new AdmZip(sourceZip).extractAllTo(projectDir, true);

    // 2. Restore node_modules cache if present
    const cacheTar = path.join(work, 'cache.tar');
    if (await r2Exists(client, env.bucket, env.cacheKey)) {
      emit(log, sink, Buffer.from(`[runner] restoring node_modules cache (${env.lockfileHash})\n`));
      await downloadToFile(client, env.bucket, env.cacheKey, cacheTar);
      mkdirSync(path.join(projectDir, 'node_modules'), { recursive: true });
      await tar.x({ file: cacheTar, cwd: path.join(projectDir, 'node_modules') });
    }

    // 3. Install
    const pm = env.packageManager;
    const installArgs = pm === 'pnpm' ? ['install', '--frozen-lockfile=false']
                       : pm === 'yarn' ? ['install']
                       : ['install', '--no-audit', '--no-fund'];
    emit(log, sink, Buffer.from(`[runner] ${pm} ${installArgs.join(' ')}\n`));
    let code = await exec(pm, installArgs, { cwd: projectDir, env: { ...process.env, ...env.userEnv }, log, sink });
    if (code !== 0) { exitCode = code; failureReason = 'BUILD_NONZERO_EXIT'; throw new Error('install failed'); }

    // 4. Build
    emit(log, sink, Buffer.from(`[runner] running build: ${env.buildCommand}\n`));
    code = await exec('sh', ['-lc', env.buildCommand], { cwd: projectDir, env: { ...process.env, ...env.userEnv }, log, sink });
    if (code !== 0) { exitCode = code; failureReason = 'BUILD_NONZERO_EXIT'; throw new Error('build failed'); }

    // 5. Validate output dir
    const outAbs = path.resolve(projectDir, env.outputDir);
    if (!existsSync(outAbs) || !statSync(outAbs).isDirectory()) {
      failureReason = 'OUTPUT_NOT_FOUND';
      throw new Error(`output dir ${env.outputDir} missing`);
    }

    // 6. Zip output dir into artifact
    const artifactZipPath = path.join(work, 'artifact.zip');
    const zip = new AdmZip();
    zip.addLocalFolder(outAbs);
    zip.writeZip(artifactZipPath);
    outputDirSize = statSync(artifactZipPath).size;
    if (outputDirSize > ARTIFACT_MAX_BYTES) {
      failureReason = 'ARTIFACT_TOO_LARGE';
      throw new Error(`artifact ${outputDirSize} > ${ARTIFACT_MAX_BYTES}`);
    }
    emit(log, sink, Buffer.from(`[runner] uploading artifact (${outputDirSize} bytes)\n`));
    await uploadFile(client, env.bucket, env.artifactKey, artifactZipPath, 'application/zip');

    // 7. Save updated cache (best-effort). Wrap the whole block: tar.c can
    // fail with ENOENT mid-walk if a build tool (npx, next-on-pages) deletes
    // a transient file inside node_modules between readdirSync and stat. The
    // artifact is already safely uploaded above, so any error here must not
    // fail the build.
    try {
      const nmDir = path.join(projectDir, 'node_modules');
      if (existsSync(nmDir)) {
        const newCacheTar = path.join(work, 'cache-out.tar');
        await tar.c({ file: newCacheTar, cwd: nmDir, portable: true }, readdirSync(nmDir));
        await uploadFile(client, env.bucket, env.cacheKey, newCacheTar, 'application/x-tar');
      }
    } catch (e) {
      emit(log, sink, Buffer.from(`[runner] cache update failed (non-fatal): ${e.message}\n`));
    }

    emit(log, sink, Buffer.from('[runner] success\n'));
  } catch (e) {
    if (!failureReason) failureReason = 'INTERNAL';
    if (exitCode === 0) exitCode = 1;
    emit(log, sink, Buffer.from(`[runner] FAILED: ${e.message}\n`));
  } finally {
    stopTimer();
    await flushLog(client, env, log).catch(() => {});
    // Status sentinel: write a tiny JSON next to the log so the driver can
    // read structured failure_reason without re-parsing logs.
    const statusKey = env.logKey.replace(/\.txt$/, '.status.json');
    await uploadBuffer(client, env.bucket, statusKey,
      Buffer.from(JSON.stringify({ exit_code: exitCode, failure_reason: failureReason })),
      'application/json').catch(() => {});
    rmSync(work, { recursive: true, force: true });
  }
  return exitCode;
}

// HTTP server: one route, POST /run. The Worker invokes this via
// container.fetch() and consumes the streamed response body.
const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/run') {
    res.statusCode = 404;
    res.end('not found');
    return;
  }
  res.statusCode = 200;
  res.setHeader('content-type', 'application/octet-stream');
  res.setHeader('cache-control', 'no-cache');

  let exitCode = 1;
  try {
    exitCode = await runBuild(res);
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    if (!res.writableEnded) {
      try { res.write(`[runner] fatal: ${msg}\n`); } catch { /* ignore */ }
    }
    // readEnv() failure or other early fatal: signal exit 99 like before.
    exitCode = 99;
  } finally {
    if (!res.writableEnded) res.end();
    // Give CF a moment to forward the trailing bytes back to the Worker
    // (which forwards them to control-api's SSE) before the container exits.
    setTimeout(() => process.exit(exitCode), 1000);
  }
});

// Bind to 0.0.0.0 explicitly: CF Containers proxies over IPv4 (10.0.0.1:8080),
// and Node's default listen() host of '::' only accepts IPv6 on some Linux
// configs, producing "container is not listening on TCP 10.0.0.1:8080".
server.listen(PORT, '0.0.0.0', () => {
  // eslint-disable-next-line no-console
  console.log(`[runner] listening on 0.0.0.0:${PORT}`);
});
