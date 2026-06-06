// services/control-api/src/services/edge-ssr-deployment.service.ts
//
// Edge SSR deployment pipeline: customers upload a zip produced by tools like
// `@cloudflare/next-on-pages` or `remix-edge` that contains a `_worker.js`
// (either a single file or a directory with chunked modules). We unpack the
// zip, push the worker script + its additional modules + static assets into
// Cloudflare Workers for Platforms via `deployUserWorkerWithScript`, then
// supersede any prior static or edge_ssr deployments for the same app.
//
// Mirrors the structure of deployment.service.ts; see deployViaWfp there for
// the static analog. Only WfP is supported — Pages cannot host edge workers.
import { Pool, PoolClient } from 'pg';
import AdmZip from 'adm-zip';
import * as R2 from './r2.js';
import * as CloudflareWfp from './cloudflare-wfp.js';
import { config } from '../config.js';
import { getRuntimeDbForApp } from './region-resolver.js';
import { decrypt } from './crypto.js';
import { notifyDeploymentFailed } from './failure-notifications.service.js';

export class DeploymentError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(message);
    this.name = 'DeploymentError';
  }
}

const MAX_DEPLOYMENT_SIZE_BYTES = 104857600; // 100 MB
const MAX_WORKER_SCRIPT_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB hard CF limit

export type EdgeSsrFramework = 'nextjs-edge' | 'remix-edge' | 'other-edge';

function normalizeZipPath(p: string): string {
  // Forward slashes, no leading slash. AdmZip already uses '/' but normalize defensively.
  return p.replace(/\\/g, '/').replace(/^\/+/, '');
}

interface ExtractedWorker {
  workerScript: Buffer;
  /** Map keyed by paths RELATIVE to `_worker.js/` (e.g. `chunks/abc.js`). */
  additionalModules: Map<string, Buffer>;
  /** Static asset files keyed by their normalized paths (no leading slash). */
  assets: Array<{ path: string; content: Buffer }>;
}

/**
 * Walk the unpacked zip entries and split them into the worker script,
 * worker-side additional modules, and static assets.
 *
 * Layout A (single file): `_worker.js` at root → that's the entry; no extra modules.
 * Layout B (directory):  `_worker.js/index.js` is entry, every other file under
 *                        `_worker.js/` is a sibling module the entry can `import`.
 *                        Cloudflare resolves cross-module imports by form-part
 *                        filename, so module keys must be RELATIVE to `_worker.js/`
 *                        (e.g. `chunks/abc.js`, NOT `_worker.js/chunks/abc.js`).
 *
 * Throws DeploymentError('MISSING_WORKER_JS') if neither layout is present.
 */
function extractWorker(entries: AdmZip.IZipEntry[]): ExtractedWorker {
  // First pass: classify every non-directory entry by normalized path.
  const fileEntries: Array<{ path: string; content: Buffer }> = [];
  for (const e of entries) {
    if (e.isDirectory) continue;
    const path = normalizeZipPath(e.entryName);
    if (!path) continue;
    fileEntries.push({ path, content: e.getData() });
  }

  // Layout A: single-file `_worker.js` at root.
  const singleFile = fileEntries.find((f) => f.path === '_worker.js');
  if (singleFile) {
    const assets = fileEntries.filter((f) => f.path !== '_worker.js');
    return {
      workerScript: singleFile.content,
      additionalModules: new Map(),
      assets,
    };
  }

  // Layout B: anything under `_worker.js/`.
  const workerDirFiles = fileEntries.filter((f) => f.path.startsWith('_worker.js/'));
  if (workerDirFiles.length > 0) {
    const indexEntry = workerDirFiles.find((f) => f.path === '_worker.js/index.js');
    if (!indexEntry) {
      throw new DeploymentError(
        'Zip has _worker.js/ directory but is missing _worker.js/index.js entry script.',
        'MISSING_WORKER_INDEX'
      );
    }
    const ALLOWED_MODULE_EXTS = new Set(['.js', '.mjs', '.wasm']);
    const additionalModules = new Map<string, Buffer>();
    for (const f of workerDirFiles) {
      if (f.path === '_worker.js/index.js') continue;
      // Strip `_worker.js/` prefix so import paths in index.js resolve correctly.
      const relKey = f.path.slice('_worker.js/'.length);
      // Only include module types that Cloudflare's worker resolver supports.
      // Sourcemaps (.map), JSON manifests, .d.ts files etc. are silently skipped.
      const ext = relKey.slice(relKey.lastIndexOf('.'));
      if (!ALLOWED_MODULE_EXTS.has(ext)) continue;
      additionalModules.set(relKey, f.content);
    }
    const assets = fileEntries.filter((f) => !f.path.startsWith('_worker.js/'));
    return {
      workerScript: indexEntry.content,
      additionalModules,
      assets,
    };
  }

  throw new DeploymentError(
    'Zip is missing _worker.js — Edge SSR deployments must include a Cloudflare Workers script. Run `npx @cloudflare/next-on-pages` first.',
    'MISSING_WORKER_JS'
  );
}

/**
 * Phase 1: insert deployment row + presigned R2 upload URL.
 */
export async function createDeployment(
  db: Pool,
  appId: string,
  userId: string,
  framework?: EdgeSsrFramework
): Promise<{ id: string; uploadUrl: string; expiresIn: number; maxSizeBytes: number }> {
  const runtimePool = await getRuntimeDbForApp(db, appId);

  try {
    const fw: EdgeSsrFramework = framework ?? 'nextjs-edge';
    // app_edge_ssr_deployments is runtime-tier
    const result = await runtimePool.query(
      `INSERT INTO app_edge_ssr_deployments (
        app_id, framework, status, deployed_by
      ) VALUES ($1, $2, 'WAITING', $3)
      RETURNING id`,
      [appId, fw, userId]
    );

    const deploymentId = result.rows[0].id;

    const { uploadUrl, objectKey, expiresIn } = await R2.generatePresignedUploadUrl(
      appId,
      deploymentId,
      MAX_DEPLOYMENT_SIZE_BYTES
    );

    await runtimePool.query(
      `UPDATE app_edge_ssr_deployments
       SET r2_object_key = $1,
           upload_expires_at = now() + interval '${expiresIn} seconds',
           updated_at = now()
       WHERE id = $2`,
      [objectKey, deploymentId]
    );

    return {
      id: deploymentId,
      uploadUrl,
      expiresIn,
      maxSizeBytes: MAX_DEPLOYMENT_SIZE_BYTES,
    };
  } catch (error) {
    if (error instanceof DeploymentError) throw error;
    throw new DeploymentError(
      `Failed to create deployment: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'CREATE_FAILED'
    );
  }
}

/**
 * Re-read the deployment row from DB. For edge SSR the pipeline is
 * synchronous (WfP push blocks until READY), so there is no external
 * Cloudflare state to poll — we just return what's in the DB.
 */
export async function syncDeploymentStatus(
  db: Pool,
  appId: string,
  deploymentId: string
): Promise<{ id: string; status: string; url?: string }> {
  const runtimePool = await getRuntimeDbForApp(db, appId);

  const result = await runtimePool.query(
    `SELECT id, status, deployment_url
     FROM app_edge_ssr_deployments
     WHERE id = $1 AND app_id = $2`,
    [deploymentId, appId]
  );

  if (result.rows.length === 0) {
    throw new DeploymentError('Edge SSR deployment not found', 'NOT_FOUND');
  }

  const row = result.rows[0];
  return {
    id: row.id,
    status: row.status,
    url: row.deployment_url ?? undefined,
  };
}

/**
 * Cancel a deployment that is still in a pre-live state.
 * Allowed from WAITING, UPLOADING, or BUILDING.
 *
 * When canceled from BUILDING the background WfP push may still complete and
 * land briefly. commitReadyAndSupersede will see the CANCELED status and skip
 * the READY transition, but the worker may go live for a moment. A warning is
 * included in the response to signal this to the caller.
 */
export async function cancelDeployment(
  db: Pool,
  appId: string,
  deploymentId: string
): Promise<{ id: string; status: string; warning?: string }> {
  const runtimePool = await getRuntimeDbForApp(db, appId);

  const result = await runtimePool.query(
    `SELECT id, status FROM app_edge_ssr_deployments WHERE id = $1 AND app_id = $2`,
    [deploymentId, appId]
  );

  if (result.rows.length === 0) {
    throw new DeploymentError('Edge SSR deployment not found', 'NOT_FOUND');
  }

  const deployment = result.rows[0];

  if (!['WAITING', 'UPLOADING', 'BUILDING'].includes(deployment.status)) {
    throw new DeploymentError(
      `Cannot cancel deployment in ${deployment.status} status`,
      'INVALID_STATUS'
    );
  }

  const wasBuilding = deployment.status === 'BUILDING';

  await runtimePool.query(
    `UPDATE app_edge_ssr_deployments
     SET status = 'CANCELED',
         completed_at = now(),
         updated_at = now()
     WHERE id = $1`,
    [deploymentId]
  );

  const response: { id: string; status: string; warning?: string } = {
    id: deploymentId,
    status: 'CANCELED',
  };

  if (wasBuilding) {
    response.warning =
      'Deployment was being pushed to Cloudflare; the worker may still go live briefly before being superseded.';
  }

  return response;
}

/**
 * Delete an edge SSR deployment row (and clean up R2 if still present).
 */
export async function deleteDeployment(
  db: Pool,
  appId: string,
  deploymentId: string
): Promise<void> {
  const runtimePool = await getRuntimeDbForApp(db, appId);

  const result = await runtimePool.query(
    `SELECT id, r2_object_key FROM app_edge_ssr_deployments WHERE id = $1 AND app_id = $2`,
    [deploymentId, appId]
  );

  if (result.rows.length === 0) {
    throw new DeploymentError('Edge SSR deployment not found', 'NOT_FOUND');
  }

  const deployment = result.rows[0];

  if (deployment.r2_object_key) {
    try {
      await R2.deleteObject(deployment.r2_object_key);
    } catch {
      // Best-effort cleanup
    }
  }

  await runtimePool.query(`DELETE FROM app_edge_ssr_deployments WHERE id = $1`, [deploymentId]);
}

/**
 * Phase 2: validate, mark UPLOADING, kick off background pipeline.
 */
export async function startDeployment(
  db: Pool,
  appId: string,
  deploymentId: string,
  _userId: string
): Promise<{ id: string; status: string }> {
  const runtimePool = await getRuntimeDbForApp(db, appId);

  const deploymentResult = await runtimePool.query(
    `SELECT id, app_id, status, r2_object_key, framework, upload_expires_at, deployment_url
     FROM app_edge_ssr_deployments
     WHERE id = $1 AND app_id = $2`,
    [deploymentId, appId]
  );

  if (deploymentResult.rows.length === 0) {
    throw new DeploymentError('Edge SSR deployment not found', 'NOT_FOUND');
  }

  const deployment = deploymentResult.rows[0];

  if (deployment.status === 'BUILDING') {
    return { id: deploymentId, status: 'BUILDING' };
  }

  if (!['WAITING', 'UPLOADING'].includes(deployment.status)) {
    throw new DeploymentError(
      `Edge SSR deployment is in ${deployment.status} status, cannot start`,
      'INVALID_STATUS'
    );
  }

  if (deployment.upload_expires_at && new Date(deployment.upload_expires_at) < new Date()) {
    await runtimePool.query(
      `UPDATE app_edge_ssr_deployments SET status = 'ERROR', error_message = 'Upload expired', updated_at = now() WHERE id = $1`,
      [deploymentId]
    );
    notifyDeploymentFailed(db, runtimePool, { appId, deploymentId, errorMessage: 'Upload expired' }).catch(() => {});
    throw new DeploymentError('Upload URL expired', 'UPLOAD_EXPIRED');
  }

  console.log(`[Edge-SSR Deploy ${deploymentId}] Starting — status=${deployment.status} r2_key=${deployment.r2_object_key} framework=${deployment.framework}`);

  await runtimePool.query(
    `UPDATE app_edge_ssr_deployments
     SET status = 'UPLOADING', started_at = now(), updated_at = now()
     WHERE id = $1`,
    [deploymentId]
  );

  runEdgeSsrPipeline(db, appId, deploymentId, deployment).catch((err) => {
    console.error(`[Edge-SSR Deploy ${deploymentId}] Unhandled pipeline error:`, err);
  });

  return { id: deploymentId, status: 'UPLOADING' };
}

/**
 * Atomically supersede all prior static/edge-ssr deployments for the app and
 * flip the current deployment to READY with its final size metrics.
 *
 * Acquires its own PoolClient so it can run an explicit transaction and is safe
 * to call after any external side-effects (WfP push, subdomain mapping) that
 * must not be inside the transaction.
 */
async function commitReadyAndSupersede(
  runtimePool: Pool,
  appId: string,
  deploymentId: string,
  result: {
    url: string;
    assetCount: number;
    totalSizeBytes: number;
    workerScriptSizeBytes: number;
    workerScriptModuleCount: number;
  }
): Promise<void> {
  // app_edge_ssr_deployments and app_deployments are both runtime-tier
  const client: PoolClient = await runtimePool.connect();
  try {
    await client.query('BEGIN');

    // Cancel-race guard: if the row was marked CANCELED while WfP was pushing,
    // skip the supersede UPDATEs and the READY transition entirely.
    // FOR UPDATE prevents a concurrent cancel from writing CANCELED between
    // our SELECT and our UPDATEs.
    const cur = await client.query(
      'SELECT status FROM app_edge_ssr_deployments WHERE id = $1 FOR UPDATE',
      [deploymentId]
    );
    if (cur.rows[0]?.status === 'CANCELED') {
      await client.query('COMMIT');
      console.log(`[Edge-SSR Deploy ${deploymentId}] Cancel detected mid-pipeline — skipping supersede & READY transition`);
      return;
    }

    await client.query(
      `UPDATE app_deployments
         SET status = 'SUPERSEDED', updated_at = now()
       WHERE app_id = $1
         AND status IN ('WAITING', 'UPLOADING', 'BUILDING', 'READY')`,
      [appId]
    );
    await client.query(
      `UPDATE app_edge_ssr_deployments
         SET status = 'SUPERSEDED', updated_at = now()
       WHERE app_id = $1
         AND id <> $2
         AND status IN ('WAITING', 'UPLOADING', 'BUILDING', 'READY')`,
      [appId, deploymentId]
    );
    await client.query(
      `UPDATE app_edge_ssr_deployments
         SET status = 'READY',
             deployment_url = $1,
             file_count = $2,
             total_size_bytes = $3,
             worker_script_size_bytes = $4,
             worker_script_module_count = $5,
             completed_at = now(),
             updated_at = now()
       WHERE id = $6
         AND status <> 'CANCELED'`,
      [
        result.url,
        result.assetCount,
        result.totalSizeBytes,
        result.workerScriptSizeBytes,
        result.workerScriptModuleCount,
        deploymentId,
      ]
    );
    await client.query('COMMIT');
  } catch (txErr) {
    await client.query('ROLLBACK').catch(() => {});
    throw txErr;
  } finally {
    client.release();
  }
}

/**
 * Background pipeline: download → extract → classify → fetch env → mark BUILDING
 * → push to WfP → write subdomain mapping → supersede prior deploys → mark READY.
 *
 * Exported for testability; normal callers go through startDeployment.
 */
export async function runEdgeSsrPipeline(
  db: Pool,
  appId: string,
  deploymentId: string,
  deployment: { r2_object_key: string; framework: string }
): Promise<void> {
  const tag = `[Edge-SSR Deploy ${deploymentId}]`;

  const runtimePool = await getRuntimeDbForApp(db, appId);

  let zipBuffer: Buffer;
  try {
    // --- 1. Download zip ---
    console.log(`${tag} Step 1/6: Downloading zip from R2 — key=${deployment.r2_object_key}`);
    const dlStart = Date.now();
    zipBuffer = await R2.downloadObjectAsBuffer(deployment.r2_object_key);
    console.log(`${tag} Step 1/6: Downloaded ${(zipBuffer.length / 1024).toFixed(0)} KB in ${Date.now() - dlStart}ms`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`${tag} Pipeline failed (download phase): ${errorMessage}`);
    await runtimePool
      .query(
        `UPDATE app_edge_ssr_deployments
         SET status = 'ERROR',
             error_message = $1,
             updated_at = now()
         WHERE id = $2`,
        [errorMessage, deploymentId]
      )
      .catch((dbErr) => console.error(`${tag} Failed to record error status:`, dbErr));
    notifyDeploymentFailed(db, runtimePool, { appId, deploymentId, errorMessage }).catch(() => {});
    return;
  }

  try {
    await deployArtifact(db, deploymentId, zipBuffer);
  } catch {
    // deployArtifact has already recorded ERROR status + notified; nothing to do.
    return;
  }

  // --- Cleanup R2 source object (only relevant on the upload-zip path) ---
  try {
    await R2.deleteObject(deployment.r2_object_key);
  } catch (error) {
    console.error(`${tag} Failed to delete R2 object ${deployment.r2_object_key}:`, error);
  }
}

/**
 * Take an already-fetched zip buffer and run the post-download Edge SSR
 * pipeline: extract → classify → fetch env → mark BUILDING → push to WfP →
 * subdomain mapping → supersede prior deploys → mark READY. Used by both the
 * upload-zip flow (runEdgeSsrPipeline) and the server-side build flow
 * (build-driver.service).
 */
export async function deployArtifact(
  db: Pool,
  deploymentId: string,
  zipBuffer: Buffer
): Promise<void> {
  const tag = `[Edge-SSR Deploy ${deploymentId}]`;
  const pipelineStart = Date.now();

  // app_edge_ssr_deployments is per-region. The caller passes deploymentId
  // alone, so scan every region to find which one owns this deployment,
  // then use that region's pool for the rest of the pipeline.
  let runtimePool: Awaited<ReturnType<typeof getRuntimeDbForApp>> | null = null;
  let appId: string | null = null;
  for (const region of Object.keys(config.runtimeDb.urlsByRegion)) {
    const pool = await import('./runtime-db.js').then((m) => m.getRuntimeDbPool(config.runtimeDb, region));
    const idRow = await pool.query<{ app_id: string }>(
      `SELECT app_id FROM app_edge_ssr_deployments WHERE id = $1`,
      [deploymentId]
    );
    if (idRow.rows.length > 0) {
      appId = idRow.rows[0].app_id;
      runtimePool = pool;
      break;
    }
  }
  if (!runtimePool || !appId) {
    throw new DeploymentError('Edge SSR deployment not found', 'NOT_FOUND');
  }

  try {
    // --- 2. Extract + classify ---
    const zip = new AdmZip(zipBuffer);
    const zipEntries = zip.getEntries();
    if (zipEntries.length === 0) {
      throw new DeploymentError('Zip file contains no entries', 'EMPTY_ZIP');
    }

    const { workerScript, additionalModules, assets } = extractWorker(zipEntries);

    let workerScriptSize = workerScript.length;
    for (const buf of additionalModules.values()) workerScriptSize += buf.length;
    if (workerScriptSize > MAX_WORKER_SCRIPT_SIZE_BYTES) {
      throw new DeploymentError(
        `Worker script exceeds 5 MB limit (got ${(workerScriptSize / 1024).toFixed(0)} KB)`,
        'WORKER_TOO_LARGE'
      );
    }

    const totalSizeBytes = workerScriptSize + assets.reduce((s, a) => s + a.content.length, 0);
    const moduleCount = 1 + additionalModules.size;

    console.log(
      `${tag} Step 2/6: Extracted worker (${(workerScriptSize / 1024).toFixed(1)} KB across ${moduleCount} modules) + ${assets.length} static asset(s)`
    );

    // --- 3. Load app row (apps is runtime-tier) ---
    const appResult = await runtimePool.query(
      `SELECT name, subdomain, deployment_backend, region FROM apps WHERE id = $1`,
      [appId]
    );
    if (appResult.rows.length === 0) {
      throw new DeploymentError('App not found', 'APP_NOT_FOUND');
    }
    const app = {
      name: appResult.rows[0].name as string,
      subdomain: (appResult.rows[0].subdomain as string | null) ?? null,
      deployment_backend: (appResult.rows[0].deployment_backend as 'pages' | 'wfp' | undefined) ?? 'pages',
      // apps.region is NOT NULL post-Phase 1, but keep a defensive fallback.
      region: (appResult.rows[0].region as string | null) ?? 'us-east-1',
    };

    if (app.deployment_backend !== 'wfp') {
      throw new DeploymentError('Edge SSR requires WfP backend', 'WRONG_BACKEND');
    }
    if (!app.subdomain) {
      throw new DeploymentError('Edge SSR deploy requires app.subdomain', 'NO_SUBDOMAIN');
    }
    if (!config.subdomain.baseDomain) {
      throw new DeploymentError('subdomain base domain is not configured', 'NO_BASE_DOMAIN');
    }

    // --- 4. Fetch + decrypt env vars (app_frontend_env_vars is runtime-tier) ---
    const envRows = await runtimePool.query(
      `SELECT key, encrypted_value FROM app_frontend_env_vars WHERE app_id = $1`,
      [appId]
    );
    const envVars: Record<string, string> = {};
    const encKey = process.env.AUTH_ENCRYPTION_KEY!;
    for (const row of envRows.rows as Array<{ key: string; encrypted_value: string }>) {
      try {
        envVars[row.key] = decrypt(row.encrypted_value, encKey);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        throw new DeploymentError(
          `Failed to decrypt env var ${row.key}: ${msg}`,
          'ENV_DECRYPT_FAILED'
        );
      }
    }

    // --- 5. Build asset Map (forward slashes, leading slash) ---
    const assetMap = new Map<string, Buffer>();
    for (const a of assets) {
      const keyPath = a.path.startsWith('/') ? a.path : `/${a.path}`;
      assetMap.set(keyPath, a.content);
    }

    // --- 6. Mark BUILDING (app_edge_ssr_deployments is runtime-tier) ---
    await runtimePool.query(
      `UPDATE app_edge_ssr_deployments SET status = 'BUILDING', updated_at = now() WHERE id = $1`,
      [deploymentId]
    );

    console.log(`${tag} Step 3/6: Deploying worker (${moduleCount} modules) + ${assets.length} assets to WfP (script=${appId})…`);
    const wfpStart = Date.now();
    // @cloudflare/next-on-pages emits a Worker that imports node:* modules
    // (node:buffer, node:async_hooks, etc.), so the script needs the
    // nodejs_compat flag at deploy time. Without it, Cloudflare serves the
    // built-in /cdn-cgi/errors/no-nodejs_compat.html page for every request.
    //
    // html_handling: 'auto-trailing-slash' is required so env.ASSETS.fetch('/')
    // resolves to /index.html for prerendered pages. The static-frontend-worker
    // uses 'none' because it implements its own candidate-resolution chain;
    // next-on-pages has no such chain and relies on CF's auto handling.
    await CloudflareWfp.deployUserWorkerWithScript(
      { scriptName: appId, files: assetMap, envVars },
      workerScript.toString('utf-8'),
      additionalModules,
      ['nodejs_compat'],
      'auto-trailing-slash'
    );
    console.log(`${tag} Step 3/6: WfP deploy completed in ${Date.now() - wfpStart}ms`);

    // --- 7. Subdomain mapping with rollback on failure ---
    console.log(`${tag} Step 4/6: Writing subdomain mapping ${app.subdomain} -> ${appId}…`);
    try {
      await CloudflareWfp.writeSubdomainMapping(app.subdomain, appId, app.region);
    } catch (err) {
      try {
        await CloudflareWfp.deleteUserWorker(appId);
      } catch {
        /* best-effort */
      }
      throw err;
    }

    const url = `https://${app.subdomain}.${config.subdomain.baseDomain}`;

    // --- 8. Supersede prior deployments (atomic with READY transition).
    // Only one Worker per app.id, so any active static OR edge_ssr deployment
    // for this app is now logically replaced and should be marked SUPERSEDED.
    console.log(`${tag} Step 5/6: Superseding prior deployments and marking READY…`);
    await commitReadyAndSupersede(runtimePool, appId, deploymentId, {
      url,
      assetCount: assets.length,
      totalSizeBytes,
      workerScriptSizeBytes: workerScriptSize,
      workerScriptModuleCount: moduleCount,
    });

    // --- 9. Update apps row (apps is runtime-tier) ---
    await runtimePool.query(
      `UPDATE apps SET deployment_url = $1, last_deployed_at = now() WHERE id = $2`,
      [url, appId]
    );

    const elapsed = ((Date.now() - pipelineStart) / 1000).toFixed(1);
    console.log(`${tag} Step 6/6: Pipeline complete in ${elapsed}s — url: ${url}`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`${tag} Pipeline failed: ${errorMessage}`);
    await runtimePool
      .query(
        `UPDATE app_edge_ssr_deployments
         SET status = 'ERROR',
             error_message = $1,
             updated_at = now()
         WHERE id = $2`,
        [errorMessage, deploymentId]
      )
      .catch((dbErr) => console.error(`${tag} Failed to record error status:`, dbErr));
    notifyDeploymentFailed(db, runtimePool, { appId, deploymentId, errorMessage }).catch(() => {});
    throw error;
  }
}
