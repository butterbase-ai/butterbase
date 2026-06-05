// services/control-api/src/services/deployment.service.ts
import { Pool } from 'pg';
import * as R2 from './r2.js';
import * as CloudflarePages from './cloudflare-pages.js';
import * as CloudflareWfp from './cloudflare-wfp.js';
import { PLACEHOLDER_SCRIPT_NAME } from './cloudflare-wfp.js';
import * as CustomHostnames from './cloudflare-custom-hostnames.js';
import AdmZip from 'adm-zip';
import { config } from '../config.js';
import { getRuntimeDbForApp } from './region-resolver.js';
import { getRuntimeDbPool } from './runtime-db.js';
import { generateTemplatePage } from './template-page.js';
import { decrypt } from './crypto.js';
import { notifyDeploymentFailed } from './failure-notifications.service.js';
import { probeSpaRouting } from './spa-routing-probe.js';
import { parseRedirects } from '@butterbase/static-frontend-worker';

export class DeploymentError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(message);
    this.name = 'DeploymentError';
  }
}

const MAX_DEPLOYMENT_SIZE_BYTES = 104857600; // 100 MB

/**
 * Create deployment record and generate presigned R2 upload URL (Phase 1)
 */
export async function createDeployment(
  db: Pool,
  appId: string,
  userId: string,
  framework?: string
): Promise<{ id: string; uploadUrl: string; expiresIn: number; maxSizeBytes: number }> {
  // Phase 2 single-region: derive runtime pool internally for runtime-tier tables
  const runtimePool = await getRuntimeDbForApp(db, appId);

  try {
    // Create deployment record with WAITING status (app_deployments is runtime-tier)
    const result = await runtimePool.query(
      `INSERT INTO app_deployments (
        app_id, framework, status, deployed_by
      ) VALUES ($1, $2, 'WAITING', $3)
      RETURNING id`,
      [appId, framework || 'other', userId]
    );

    const deploymentId = result.rows[0].id;

    // Generate presigned R2 upload URL
    const { uploadUrl, objectKey, expiresIn } = await R2.generatePresignedUploadUrl(
      appId,
      deploymentId,
      MAX_DEPLOYMENT_SIZE_BYTES
    );

    // Update deployment record with R2 key and expiry
    await runtimePool.query(
      `UPDATE app_deployments
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
    throw new DeploymentError(
      `Failed to create deployment: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'CREATE_FAILED'
    );
  }
}

/**
 * Deploy a template landing page during app init. Branches on
 * apps.deployment_backend: Pages apps get a dedicated Pages project + DNS
 * CNAME; WfP apps get a single KV pointer at the shared placeholder worker.
 *
 * Best-effort: failures are logged but never thrown — init should not fail
 * because of CF.
 *
 * Returns a backend-specific identifier on success (Pages project name or
 * the placeholder sentinel), or null on failure.
 */
export async function deployTemplatePage(
  db: Pool,
  appId: string,
  subdomain: string,
  appName: string,
  userId: string
): Promise<string | null> {
  if (!config.cloudflare.enabled) {
    console.log(`[Template ${appId}] Cloudflare not enabled, skipping template deployment`);
    return null;
  }

  const runtimePool = await getRuntimeDbForApp(db, appId);

  const row = await runtimePool.query<{ deployment_backend: 'pages' | 'wfp'; region: string }>(
    `SELECT deployment_backend, region FROM apps WHERE id = $1`,
    [appId]
  );
  const backend = row.rows[0]?.deployment_backend ?? 'pages';
  const appRegion = row.rows[0]?.region ?? 'us-east-1';

  if (backend === 'wfp') {
    return deployTemplatePageViaWfp(runtimePool, appId, subdomain, userId, appRegion);
  }
  return deployTemplatePageViaPages(runtimePool, appId, subdomain, appName, userId);
}

async function deployTemplatePageViaPages(
  db: Pool,
  appId: string,
  subdomain: string,
  appName: string,
  userId: string
): Promise<string | null> {
  const tag = `[Template ${appId}]`;
  const start = Date.now();

  try {
    const appSlug = appName.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const projectName = `bb-${appSlug}`;

    console.log(`${tag} Step 1/4: Creating CF Pages project ${projectName}…`);
    try {
      await CloudflarePages.getProject(projectName);
    } catch (error) {
      if (error instanceof CloudflarePages.CloudflareError && error.statusCode === 404) {
        await CloudflarePages.createProject(appSlug);
      } else {
        throw error;
      }
    }

    console.log(`${tag} Step 2/4: Deploying template page…`);
    const files = generateTemplatePage(appName, subdomain, appId, config.subdomain.baseDomain);
    const cfDeployment = await CloudflarePages.createDeployment(projectName, files);
    console.log(`${tag} Step 2/4: Deployed in ${Date.now() - start}ms: ${cfDeployment.url}`);

    let customDomainUrl = cfDeployment.url;
    if (subdomain && config.subdomain.baseDomain) {
      const customDomain = `${subdomain}.${config.subdomain.baseDomain}`;
      const pagesTarget = `${projectName}.pages.dev`;

      console.log(`${tag} Step 3/4: Creating DNS record ${customDomain} → ${pagesTarget}…`);
      await CloudflarePages.createDnsRecord(customDomain, pagesTarget);

      console.log(`${tag} Step 4/4: Adding custom domain…`);
      await CloudflarePages.addCustomDomain(projectName, customDomain);
      customDomainUrl = `https://${customDomain}`;
    } else {
      console.log(`${tag} Step 3/4: Skipped DNS (no subdomain)`);
      console.log(`${tag} Step 4/4: Skipped custom domain`);
    }

    await db.query(
      `INSERT INTO app_deployments (
        app_id, framework, status, deployed_by, deployment_url,
        cloudflare_project_name, cloudflare_deployment_id,
        file_count, total_size_bytes, started_at, completed_at
      ) VALUES ($1, 'template', 'READY', $2, $3, $4, $5, $6, $7, now(), now())`,
      [
        appId, userId, customDomainUrl, projectName,
        cfDeployment.id, files.length,
        files.reduce((sum, f) => sum + f.content.length, 0),
      ]
    );

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`${tag} Template deployment complete in ${elapsed}s — url: ${customDomainUrl}`);

    return projectName;
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.warn(`${tag} Template deployment failed (non-fatal): ${msg}`);
    return null;
  }
}

async function deployTemplatePageViaWfp(
  db: Pool,
  appId: string,
  subdomain: string,
  userId: string,
  region: string,
): Promise<string | null> {
  const tag = `[Template ${appId}]`;
  const start = Date.now();

  try {
    if (!subdomain) {
      console.log(`${tag} WfP path: no subdomain, skipping placeholder mapping`);
      return null;
    }
    if (!config.subdomain.baseDomain) {
      console.log(`${tag} WfP path: no baseDomain configured, skipping placeholder mapping`);
      return null;
    }

    console.log(`${tag} Step 1/2: Writing KV sub:${subdomain} → ${PLACEHOLDER_SCRIPT_NAME}…`);
    await CloudflareWfp.writeSubdomainMapping(subdomain, PLACEHOLDER_SCRIPT_NAME, region);

    const deploymentUrl = `https://${subdomain}.${config.subdomain.baseDomain}`;

    console.log(`${tag} Step 2/2: Recording template deployment row…`);
    await db.query(
      `INSERT INTO app_deployments (
        app_id, framework, status, deployed_by, deployment_url,
        cloudflare_project_name, cloudflare_deployment_id,
        file_count, total_size_bytes, started_at, completed_at
      ) VALUES ($1, 'template', 'READY', $2, $3, NULL, NULL, 0, 0, now(), now())`,
      [appId, userId, deploymentUrl]
    );

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`${tag} WfP placeholder mapping complete in ${elapsed}s — url: ${deploymentUrl}`);

    return PLACEHOLDER_SCRIPT_NAME;
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.warn(`${tag} WfP placeholder mapping failed (non-fatal): ${msg}`);
    return null;
  }
}

/**
 * Remove old deployments beyond the plan's retention limit.
 * Called after a successful deployment. Only removes DB records and cancels CF deployments.
 * Never touches the CF project or DNS — those persist for the app's lifetime.
 *
 * Phase 2 multi-region: apps is runtime-tier; platform_users + plans are control-tier.
 * The former cross-tier JOIN is split into two queries across the two pools.
 */
async function cleanupOldDeployments(
  controlPool: Pool,
  runtimePool: Pool,
  appId: string,
  currentDeploymentId: string,
  userId: string
): Promise<void> {
  const tag = `[Cleanup ${appId}]`;

  try {
    // 1. Get the app's owner_id from runtime DB
    const appRow = await runtimePool.query(
      `SELECT owner_id FROM apps WHERE id = $1`,
      [appId],
    );
    const ownerId = appRow.rows[0]?.owner_id;

    let maxDeployments = 10;
    if (ownerId) {
      // 2. Get the owner's plan retention limit from control DB
      const planResult = await controlPool.query(
        `SELECT p.max_deployments
         FROM platform_users pu
         JOIN plans p ON pu.plan_id = p.id
         WHERE pu.id = $1`,
        [ownerId],
      );
      maxDeployments = planResult.rows[0]?.max_deployments ?? 10;
    }

    // -1 means unlimited
    if (maxDeployments === -1) {
      console.log(`${tag} Unlimited retention, skipping cleanup`);
      return;
    }

    // Get all deployments for this app, newest first, skip the ones we keep
    const excessResult = await runtimePool.query(
      `SELECT id, cloudflare_project_name, cloudflare_deployment_id, r2_object_key
       FROM app_deployments
       WHERE app_id = $1
       ORDER BY created_at DESC
       OFFSET $2`,
      [appId, maxDeployments]
    );

    if (excessResult.rows.length === 0) {
      console.log(`${tag} No excess deployments to clean up (${maxDeployments} limit)`);
      return;
    }

    console.log(`${tag} Cleaning up ${excessResult.rows.length} old deployment(s) (limit: ${maxDeployments})…`);

    for (const row of excessResult.rows) {
      // Cancel CF deployment (best-effort)
      if (row.cloudflare_deployment_id && row.cloudflare_project_name) {
        try {
          await CloudflarePages.cancelDeployment(
            row.cloudflare_project_name,
            row.cloudflare_deployment_id
          );
        } catch {
          // Ignore — deployment may already be gone
        }
      }

      // Clean up R2 object if present
      if (row.r2_object_key) {
        try {
          await R2.deleteObject(row.r2_object_key);
        } catch {
          // Ignore cleanup failures
        }
      }

      // Delete the deployment record
      await runtimePool.query(`DELETE FROM app_deployments WHERE id = $1`, [row.id]);
    }

    console.log(`${tag} Cleaned up ${excessResult.rows.length} old deployment(s)`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.warn(`${tag} Cleanup failed (non-fatal): ${msg}`);
  }
}

/**
 * Start deployment: validates, marks as UPLOADING, then runs the heavy
 * pipeline (R2 download → extract → wrangler deploy → custom domain)
 * in the background so the HTTP request returns immediately.
 * Callers poll GET /deployments/:id for status.
 */
export async function startDeployment(
  db: Pool,
  appId: string,
  deploymentId: string,
  userId: string
): Promise<{ id: string; status: string }> {
  // Phase 2 single-region: derive runtime pool internally for runtime-tier tables
  const runtimePool = await getRuntimeDbForApp(db, appId);

  // Get deployment record (app_deployments is runtime-tier)
  const deploymentResult = await runtimePool.query(
    `SELECT id, app_id, status, r2_object_key, framework, upload_expires_at, deployment_url, cloudflare_deployment_id
     FROM app_deployments
     WHERE id = $1 AND app_id = $2`,
    [deploymentId, appId]
  );

  if (deploymentResult.rows.length === 0) {
    throw new DeploymentError('Deployment not found', 'NOT_FOUND');
  }

  const deployment = deploymentResult.rows[0];

  // If deployment already reached BUILDING or later, the pipeline already ran
  // (zip downloaded, deployed to Cloudflare, R2 object deleted). Return current state.
  if (deployment.status === 'BUILDING') {
    return { id: deploymentId, status: 'BUILDING' };
  }

  if (!['WAITING', 'UPLOADING'].includes(deployment.status)) {
    throw new DeploymentError(
      `Deployment is in ${deployment.status} status, cannot start`,
      'INVALID_STATUS'
    );
  }

  // Check if upload expired
  if (deployment.upload_expires_at && new Date(deployment.upload_expires_at) < new Date()) {
    await runtimePool.query(
      `UPDATE app_deployments SET status = 'ERROR', error_message = 'Upload expired', updated_at = now() WHERE id = $1`,
      [deploymentId]
    );
    notifyDeploymentFailed(db, runtimePool, { appId, deploymentId, errorMessage: 'Upload expired' }).catch(() => {});
    throw new DeploymentError('Upload URL expired', 'UPLOAD_EXPIRED');
  }

  console.log(`[Deploy ${deploymentId}] Starting — status=${deployment.status} r2_key=${deployment.r2_object_key} framework=${deployment.framework}`);

  // Mark as UPLOADING and return immediately — heavy work runs in background
  await runtimePool.query(
    `UPDATE app_deployments
     SET status = 'UPLOADING', started_at = now(), updated_at = now()
     WHERE id = $1`,
    [deploymentId]
  );

  runDeploymentPipeline(db, appId, deploymentId, deployment).catch((err) => {
    console.error(`[Deploy ${deploymentId}] Unhandled pipeline error:`, err);
  });

  return { id: deploymentId, status: 'UPLOADING' };
}

interface PipelineCtx {
  /** control-tier pool (platform_users, plans) */
  db: Pool;
  /** runtime-tier pool (apps, app_deployments, app_frontend_env_vars, etc.) */
  runtimePool: Pool;
  appId: string;
  deploymentId: string;
  tag: string;
  files: CloudflarePages.FileEntry[];
  totalSizeBytes: number;
  framework: string;
  app: {
    name: string;
    subdomain: string | null;
    cloudflare_project_name: string | null;
    deployment_backend: 'pages' | 'wfp';
    region: string;
  };
}

interface DeployResult {
  url: string;
  cloudflareProjectName: string | null;
  cloudflareDeploymentId: string | null;
  /** Terminal status reached after this deploy path completes. */
  status: 'BUILDING' | 'READY';
}

/**
 * Cloudflare Pages deploy path — preserves original behavior.
 * Injects _redirects for SPA frameworks, resolves/creates the CF Pages project,
 * deploys via wrangler, and sets up DNS + custom domain on the fallback path.
 * Ends in 'BUILDING' status; a subsequent syncDeploymentStatus transitions to READY.
 */
async function deployViaPages(ctx: PipelineCtx): Promise<DeployResult> {
  const { runtimePool, appId, tag, files, framework, app } = ctx;

  // Inject _redirects for SPA frameworks if not already present
  const hasRedirects = files.some((f) => f.path.replace(/^\//, '') === '_redirects');
  const isSpaFramework = ['react-vite', 'nextjs-static', 'other'].includes(framework);
  if (!hasRedirects && isSpaFramework) {
    files.push({ path: '_redirects', content: Buffer.from('/* /index.html 200\n') });
  }

  const appName = app.name;
  const appSubdomain = app.subdomain;
  let projectName = app.cloudflare_project_name;

  if (!projectName) {
    // Fallback for apps created before this change — create project if missing
    projectName = `bb-${appName.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`;
    try {
      await CloudflarePages.getProject(projectName);
    } catch (error) {
      if (error instanceof CloudflarePages.CloudflareError && error.statusCode === 404) {
        await CloudflarePages.createProject(appName.toLowerCase().replace(/[^a-z0-9-]/g, '-'));
      } else {
        throw error;
      }
    }
    // Store for future deploys (apps is runtime-tier)
    await runtimePool.query(
      `UPDATE apps SET cloudflare_project_name = $1 WHERE id = $2`,
      [projectName, appId]
    );
  }

  // --- Deploy via wrangler ---
  console.log(`${tag} Step 3/5: Deploying ${files.length} files to Cloudflare Pages (${projectName})…`);
  const wranglerStart = Date.now();
  const cfDeployment = await CloudflarePages.createDeployment(projectName, files);
  console.log(`${tag} Step 3/5: Cloudflare deployment created in ${Date.now() - wranglerStart}ms: ${cfDeployment.url}`);

  // --- Custom domain (skip if project was already set up at init time) ---
  console.log(`${tag} Step 4/5: Custom domain setup…`);
  let customDomainUrl = cfDeployment.url;

  // Only set up DNS + custom domain if this is the fallback path (pre-existing app without CF project)
  const needsDomainSetup = !app.cloudflare_project_name;

  if (needsDomainSetup && appSubdomain && config.subdomain.baseDomain) {
    const customDomain = `${appSubdomain}.${config.subdomain.baseDomain}`;
    try {
      const pagesTarget = `${projectName}.pages.dev`;
      await CloudflarePages.createDnsRecord(customDomain, pagesTarget);
      await CloudflarePages.addCustomDomain(projectName, customDomain);
      customDomainUrl = `https://${customDomain}`;
      console.log(`${tag} Step 4/5: Custom domain configured: ${customDomainUrl}`);
    } catch (error) {
      console.warn(`${tag} Step 4/5: Failed to set up custom domain ${customDomain}:`, error);
    }
  } else if (appSubdomain && config.subdomain.baseDomain) {
    // Project was set up at init — domain already configured, just use it
    customDomainUrl = `https://${appSubdomain}.${config.subdomain.baseDomain}`;
    console.log(`${tag} Step 4/5: Using existing custom domain: ${customDomainUrl}`);
  } else {
    console.log(`${tag} Step 4/5: Skipped (no subdomain configured)`);
  }

  return {
    url: customDomainUrl,
    cloudflareProjectName: projectName,
    cloudflareDeploymentId: cfDeployment.id,
    status: 'BUILDING',
  };
}

/**
 * Workers-for-Platforms deploy path.
 * Uploads files + env bindings to a per-app dispatch worker and writes the
 * subdomain -> appId mapping into the shared KV. WfP is synchronous, so this
 * path transitions directly to READY (no follow-up CF poll).
 * Does NOT inject _redirects — WfP handles SPA fallback via explicit
 * in-worker rewrite to /index.html (see WORKER_JS in cloudflare-wfp.ts).
 */
async function deployViaWfp(ctx: PipelineCtx): Promise<DeployResult> {
  const { runtimePool, appId, tag, files, app } = ctx;

  if (!app.subdomain) {
    throw new DeploymentError('WfP deploy requires app.subdomain', 'NO_SUBDOMAIN');
  }

  if (!config.subdomain.baseDomain) {
    throw new DeploymentError('subdomain base domain is not configured', 'NO_BASE_DOMAIN');
  }

  // Build Map<absolute-path, Buffer> with forward-slash keys (normalize windows backslashes)
  const fileMap = new Map<string, Buffer>();
  for (const f of files) {
    const normalized = f.path.replace(/\\/g, '/');
    const keyPath = normalized.startsWith('/') ? normalized : `/${normalized}`;
    fileMap.set(keyPath, f.content);
  }

  // Fetch + decrypt env vars for this app (app_frontend_env_vars is runtime-tier).
  // Mirror the writer's key expression exactly (see routes/frontend.ts: process.env.AUTH_ENCRYPTION_KEY!)
  // so encrypt/decrypt stay symmetric. If decrypt fails, fail the deploy — we must never
  // silently drop env vars the user's app depends on.
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

  // Parse user-shipped `_redirects` (if any) and bake the rules into a system
  // binding `BB_REDIRECTS_RULES`. The worker reads this at request time and
  // applies rules BEFORE asset lookup (see worker.ts). Set after the user env
  // var loop so a malicious/curious user setting BB_REDIRECTS_RULES via
  // app_frontend_env_vars cannot override platform behavior.
  const redirectsFile = files.find(
    (f) => f.path.replace(/^\/+/, '') === '_redirects',
  );
  if (redirectsFile) {
    const content = redirectsFile.content.toString('utf8');
    const { rules, warnings } = parseRedirects(content);
    if (warnings.length > 0) {
      console.warn(
        `${tag} Step 3/5: _redirects parsed with ${warnings.length} warning(s):`,
      );
      for (const w of warnings) console.warn(`${tag}   ${w}`);
    }
    if (rules.length > 0) {
      envVars.BB_REDIRECTS_RULES = JSON.stringify(rules);
      console.log(
        `${tag} Step 3/5: parsed ${rules.length} _redirects rule(s) → BB_REDIRECTS_RULES binding`,
      );
    }
  }

  console.log(`${tag} Step 3/5: Deploying ${files.length} files to WfP (script=${appId})…`);
  const wfpStart = Date.now();
  await CloudflareWfp.deployUserWorker({
    scriptName: appId,
    files: fileMap,
    envVars,
  });
  console.log(`${tag} Step 3/5: WfP deploy completed in ${Date.now() - wfpStart}ms`);

  console.log(`${tag} Step 4/5: Writing subdomain mapping ${app.subdomain} -> ${appId}…`);
  try {
    await CloudflareWfp.writeSubdomainMapping(app.subdomain, appId, app.region);
  } catch (err) {
    // Compensate: remove the worker we just uploaded so state stays consistent.
    // Without the KV mapping, the dispatch worker is unreachable — an orphan.
    try {
      await CloudflareWfp.deleteUserWorker(appId);
    } catch {
      /* best-effort */
    }
    throw err;
  }

  const url = `https://${app.subdomain}.${config.subdomain.baseDomain}`;

  // Step 5/5: Probe SPA routing on the live URL. Catches any future regression
  // of the html_handling 307 trap (PR #33) at the deploy boundary instead of
  // via user complaint. The probe hits a random deep path and asserts the
  // worker's SPA fallback resolves it to 200 + text/html. Skipped only when
  // explicitly disabled via env (e.g. for offline/staging environments where
  // the URL isn't reachable from control-api).
  if (process.env.SPA_ROUTING_PROBE_DISABLED !== 'true') {
    console.log(`${tag} Step 5/5: Probing SPA routing at ${url}…`);
    const probeStart = Date.now();
    const result = await probeSpaRouting(url);
    if (!result.ok) {
      console.error(
        `${tag} Step 5/5: SPA routing probe FAILED after ${Date.now() - probeStart}ms: ${result.reason}`,
      );
      throw new DeploymentError(
        `SPA routing probe failed: ${result.reason}. The worker is uploaded but deep paths are not resolving to index.html. ` +
          `This usually means the in-worker SPA fallback or html_handling config is broken. ` +
          `Investigate before redeploying.`,
        'SPA_ROUTING_PROBE_FAILED',
      );
    }
    console.log(`${tag} Step 5/5: SPA routing probe OK in ${Date.now() - probeStart}ms`);
  } else {
    console.log(`${tag} Step 5/5: SPA routing probe skipped (SPA_ROUTING_PROBE_DISABLED=true)`);
  }

  return {
    url,
    cloudflareProjectName: null,
    cloudflareDeploymentId: null,
    status: 'READY',
  };
}

/**
 * Background pipeline: download zip, extract, deploy (Pages or WfP based on
 * apps.deployment_backend), configure custom domain, update DB status throughout.
 *
 * Exported for testability. Normal callers should go through startDeployment.
 */
export async function runDeploymentPipeline(
  db: Pool,
  appId: string,
  deploymentId: string,
  deployment: { r2_object_key: string; framework: string }
): Promise<void> {
  const tag = `[Deploy ${deploymentId}]`;

  // Phase 2 single-region: derive runtime pool internally for runtime-tier tables
  const runtimePool = await getRuntimeDbForApp(db, appId);

  let zipBuffer: Buffer;
  try {
    console.log(`${tag} Step 1/5: Downloading zip from R2 — key=${deployment.r2_object_key}`);
    const dlStart = Date.now();
    zipBuffer = await R2.downloadObjectAsBuffer(deployment.r2_object_key);
    console.log(`${tag} Step 1/5: Downloaded ${(zipBuffer.length / 1024).toFixed(0)} KB in ${Date.now() - dlStart}ms`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`${tag} Pipeline failed (download phase): ${errorMessage}`);
    await runtimePool.query(
      `UPDATE app_deployments
       SET status = 'ERROR',
           error_message = $1,
           updated_at = now()
       WHERE id = $2`,
      [errorMessage, deploymentId]
    ).catch((dbErr) => console.error(`${tag} Failed to record error status:`, dbErr));
    notifyDeploymentFailed(db, runtimePool, { appId, deploymentId, errorMessage }).catch(() => {});
    return;
  }

  try {
    await deployArtifact(db, deploymentId, zipBuffer);
  } catch {
    // deployArtifact has already recorded ERROR status + notified.
    return;
  }

  // --- Cleanup R2 source object (only relevant on the upload-zip path) ---
  try {
    await R2.deleteObject(deployment.r2_object_key);
  } catch (error) {
    console.error(`${tag} Failed to delete R2 object ${deployment.r2_object_key}:`, error);
  }

  // --- Cleanup old deployments beyond plan retention limit ---
  await cleanupOldDeployments(db, runtimePool, appId, deploymentId, '');
}

/**
 * Take an already-fetched zip buffer and run the post-download static-frontend
 * pipeline: extract → deploy (Pages or WfP) → update DB. Used by both the
 * upload-zip flow (runDeploymentPipeline) and the server-side build flow
 * (build-driver.service).
 */
export async function deployArtifact(
  db: Pool,
  deploymentId: string,
  zipBuffer: Buffer
): Promise<void> {
  const tag = `[Deploy ${deploymentId}]`;
  const pipelineStart = Date.now();

  // app_deployments is per-region. The caller only has deploymentId, so
  // scan every region to find which one owns this deployment.
  let runtimePool: Awaited<ReturnType<typeof getRuntimeDbForApp>> | null = null;
  let appId: string | null = null;
  let framework: string | null = null;
  for (const region of Object.keys(config.runtimeDb.urlsByRegion)) {
    const pool = getRuntimeDbPool(config.runtimeDb, region);
    const idRow = await pool.query<{ app_id: string; framework: string }>(
      `SELECT app_id, framework FROM app_deployments WHERE id = $1`,
      [deploymentId]
    );
    if (idRow.rows.length > 0) {
      appId = idRow.rows[0].app_id;
      framework = idRow.rows[0].framework;
      runtimePool = pool;
      break;
    }
  }
  if (!runtimePool || !appId || !framework) {
    throw new DeploymentError('Deployment not found', 'NOT_FOUND');
  }

  try {
    // --- Extract files ---
    const zip = new AdmZip(zipBuffer);
    const zipEntries = zip.getEntries();

    const files: CloudflarePages.FileEntry[] = [];
    let totalSizeBytes = 0;

    for (const entry of zipEntries) {
      if (!entry.isDirectory) {
        const content = entry.getData();
        files.push({ path: entry.entryName, content });
        totalSizeBytes += entry.header.size;
      }
    }

    if (files.length === 0) {
      throw new DeploymentError('Zip file contains no files', 'EMPTY_ZIP');
    }

    console.log(`${tag} Step 2/5: Extracted ${files.length} files (${(totalSizeBytes / 1024).toFixed(0)} KB)`);

    // --- Load app row, including deployment_backend selector (apps is runtime-tier) ---
    const appResult = await runtimePool.query(
      `SELECT name, subdomain, cloudflare_project_name, deployment_backend, region FROM apps WHERE id = $1`,
      [appId]
    );

    if (appResult.rows.length === 0) {
      throw new DeploymentError('App not found', 'APP_NOT_FOUND');
    }

    const app = {
      name: appResult.rows[0].name as string,
      subdomain: (appResult.rows[0].subdomain as string | null) ?? null,
      cloudflare_project_name: (appResult.rows[0].cloudflare_project_name as string | null) ?? null,
      deployment_backend: (appResult.rows[0].deployment_backend as 'pages' | 'wfp' | undefined) ?? 'pages',
      // apps.region is NOT NULL post-Phase 1, but keep a defensive default.
      region: (appResult.rows[0].region as string | null) ?? 'us-east-1',
    };

    const ctx: PipelineCtx = {
      db,
      runtimePool,
      appId,
      deploymentId,
      tag,
      files,
      totalSizeBytes,
      framework,
      app,
    };

    // --- Branch on deployment backend ---
    const result = app.deployment_backend === 'wfp'
      ? await deployViaWfp(ctx)
      : await deployViaPages(ctx);

    // --- Persist artifact slot for clone replay ---
    // Once the platform has accepted the bundle (no throw from deployVia*),
    // overwrite the per-app artifact slot with the exact bytes that were
    // published. The clone worker copies this object verbatim onto the dest
    // so cloned apps get byte-for-byte identical frontends. One slot per
    // app (overwritten on every deploy) — storage stays bounded. Best-effort:
    // failure to persist does NOT roll back the deploy, since the live edge
    // is already serving the new artifact.
    try {
      await R2.putObject(R2.appArtifactKey(appId), zipBuffer, 'application/zip');
    } catch (err) {
      console.error(`${tag} Failed to persist app-artifact slot (deploy itself succeeded):`, err);
    }

    // --- Update deployment record (app_deployments is runtime-tier) ---
    console.log(`${tag} Step 5/5: Updating DB…`);
    await runtimePool.query(
      `UPDATE app_deployments
       SET status = $1,
           deployment_url = $2,
           cloudflare_project_name = $3,
           cloudflare_deployment_id = $4,
           file_count = $5,
           total_size_bytes = $6,
           completed_at = CASE WHEN $1 = 'READY' THEN now() ELSE completed_at END,
           updated_at = now()
       WHERE id = $7`,
      [
        result.status,
        result.url,
        result.cloudflareProjectName,
        result.cloudflareDeploymentId,
        files.length,
        totalSizeBytes,
        deploymentId,
      ]
    );

    // Route-mapping write: webhook handlers consult cloudflare_deployment_index
    // on controlDb to resolve (cloudflare_deployment_id -> app_id, region) without
    // touching the per-region app_deployments. Best-effort: a failure here logs
    // and does not fail the deploy; the webhook handler falls back gracefully.
    if (result.cloudflareDeploymentId) {
      try {
        await db.query(
          `INSERT INTO cloudflare_deployment_index (cloudflare_deployment_id, app_id, region)
           VALUES ($1, $2, $3)
           ON CONFLICT (cloudflare_deployment_id) DO NOTHING`,
          [result.cloudflareDeploymentId, appId, app.region]
        );
      } catch (err) {
        console.error({ err, appId, cloudflareDeploymentId: result.cloudflareDeploymentId, region: app.region },
          '[deployArtifact] cloudflare_deployment_index write failed — webhook routing may need fallback');
      }
    }

    // If terminal READY (WfP), also update apps.deployment_url + last_deployed_at,
    // and supersede any active Edge SSR deployments for the same app — they share
    // the same dispatch-namespace Worker script slot so a static WfP deploy replaces them.
    // Pages deploys are irrelevant here: Pages and WfP use separate infrastructure.
    if (result.status === 'READY') {
      await runtimePool.query(
        `UPDATE apps SET deployment_url = $1, last_deployed_at = now() WHERE id = $2`,
        [result.url, appId]
      );

      // Mark any active Edge SSR rows as SUPERSEDED (WfP static deploy takes the same script slot).
      // app_edge_ssr_deployments is runtime-tier.
      await runtimePool.query(
        `UPDATE app_edge_ssr_deployments
         SET status = 'SUPERSEDED', updated_at = now()
         WHERE app_id = $1 AND status IN ('WAITING','UPLOADING','BUILDING','READY')`,
        [appId]
      );
    }

    const elapsed = ((Date.now() - pipelineStart) / 1000).toFixed(1);
    console.log(`${tag} Pipeline complete in ${elapsed}s — status: ${result.status}, url: ${result.url}`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`${tag} Pipeline failed: ${errorMessage}`);
    await runtimePool.query(
      `UPDATE app_deployments
       SET status = 'ERROR',
           error_message = $1,
           updated_at = now()
       WHERE id = $2`,
      [errorMessage, deploymentId]
    ).catch((dbErr) => console.error(`${tag} Failed to record error status:`, dbErr));
    notifyDeploymentFailed(db, runtimePool, { appId, deploymentId, errorMessage }).catch(() => {});
    throw error;
  }
}

/**
 * Sync deployment status from Cloudflare
 */
export async function syncDeploymentStatus(
  db: Pool,
  appId: string,
  deploymentId: string
): Promise<{ id: string; status: string; url?: string }> {
  // Phase 2 single-region: derive runtime pool internally for runtime-tier tables
  const runtimePool = await getRuntimeDbForApp(db, appId);

  try {
    // Get deployment record (app_deployments is runtime-tier)
    const result = await runtimePool.query(
      `SELECT id, cloudflare_project_name, cloudflare_deployment_id, status
       FROM app_deployments
       WHERE id = $1 AND app_id = $2`,
      [deploymentId, appId]
    );

    if (result.rows.length === 0) {
      throw new DeploymentError('Deployment not found', 'NOT_FOUND');
    }

    const deployment = result.rows[0];

    if (!deployment.cloudflare_deployment_id) {
      throw new DeploymentError('Deployment has no Cloudflare deployment ID', 'NO_CLOUDFLARE_ID');
    }

    // Fetch status from Cloudflare
    const cfDeployment = await CloudflarePages.getDeployment(
      deployment.cloudflare_project_name,
      deployment.cloudflare_deployment_id
    );

    // Map Cloudflare status to our status
    let status = deployment.status;
    if (cfDeployment.latest_stage.status === 'success') {
      status = 'READY';
    } else if (cfDeployment.latest_stage.status === 'failure') {
      status = 'ERROR';
    } else if (cfDeployment.latest_stage.status === 'canceled') {
      status = 'CANCELED';
    }

    const wasNotErrorBefore = deployment.status !== 'ERROR';

    // Update deployment record (runtime-tier)
    await runtimePool.query(
      `UPDATE app_deployments
       SET status = $1,
           deployment_url = $2,
           completed_at = CASE WHEN $1 IN ('READY', 'ERROR', 'CANCELED') THEN now() ELSE completed_at END,
           updated_at = now()
       WHERE id = $3`,
      [status, cfDeployment.url, deploymentId]
    );

    if (status === 'ERROR' && wasNotErrorBefore) {
      const cfStage = cfDeployment.latest_stage.name ? `${cfDeployment.latest_stage.name} stage failed` : 'Cloudflare reported failure';
      notifyDeploymentFailed(db, runtimePool, { appId, deploymentId, errorMessage: cfStage }).catch(() => {});
    }

    // Update apps table if READY (apps is runtime-tier)
    if (status === 'READY') {
      await runtimePool.query(
        `UPDATE apps
         SET deployment_url = $1, last_deployed_at = now()
         WHERE id = $2`,
        [cfDeployment.url, appId]
      );
    }

    return {
      id: deploymentId,
      status,
      url: cfDeployment.url,
    };
  } catch (error) {
    if (error instanceof DeploymentError) {
      throw error;
    }
    throw new DeploymentError(
      `Failed to sync deployment status: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'SYNC_FAILED'
    );
  }
}

/**
 * Cancel deployment
 */
export async function cancelDeployment(
  db: Pool,
  appId: string,
  deploymentId: string
): Promise<{ id: string; status: string }> {
  // Phase 2 single-region: derive runtime pool internally for runtime-tier tables
  const runtimePool = await getRuntimeDbForApp(db, appId);

  try {
    // Get deployment record (app_deployments is runtime-tier)
    const result = await runtimePool.query(
      `SELECT id, cloudflare_project_name, cloudflare_deployment_id, status
       FROM app_deployments
       WHERE id = $1 AND app_id = $2`,
      [deploymentId, appId]
    );

    if (result.rows.length === 0) {
      throw new DeploymentError('Deployment not found', 'NOT_FOUND');
    }

    const deployment = result.rows[0];

    // Can only cancel WAITING, UPLOADING, or BUILDING deployments
    if (!['WAITING', 'UPLOADING', 'BUILDING'].includes(deployment.status)) {
      throw new DeploymentError(
        `Cannot cancel deployment in ${deployment.status} status`,
        'INVALID_STATUS'
      );
    }

    // Cancel in Cloudflare if deployment exists
    if (deployment.cloudflare_deployment_id) {
      try {
        await CloudflarePages.cancelDeployment(
          deployment.cloudflare_project_name,
          deployment.cloudflare_deployment_id
        );
      } catch (error) {
        console.error('Failed to cancel Cloudflare deployment:', error);
        // Continue with local cancellation even if Cloudflare fails
      }
    }

    // Update deployment record (runtime-tier)
    await runtimePool.query(
      `UPDATE app_deployments
       SET status = 'CANCELED',
           completed_at = now(),
           updated_at = now()
       WHERE id = $1`,
      [deploymentId]
    );

    return {
      id: deploymentId,
      status: 'CANCELED',
    };
  } catch (error) {
    if (error instanceof DeploymentError) {
      throw error;
    }
    throw new DeploymentError(
      `Failed to cancel deployment: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'CANCEL_FAILED'
    );
  }
}

/**
 * Delete a deployment (removes from Cloudflare and database)
 */
export async function deleteDeployment(
  db: Pool,
  appId: string,
  deploymentId: string
): Promise<void> {
  // Phase 2 single-region: derive runtime pool internally for runtime-tier tables
  const runtimePool = await getRuntimeDbForApp(db, appId);

  const result = await runtimePool.query(
    `SELECT id, cloudflare_project_name, cloudflare_deployment_id, r2_object_key
     FROM app_deployments
     WHERE id = $1 AND app_id = $2`,
    [deploymentId, appId]
  );

  if (result.rows.length === 0) {
    throw new DeploymentError('Deployment not found', 'NOT_FOUND');
  }

  const deployment = result.rows[0];

  // Cancel the Cloudflare deployment if it exists
  if (deployment.cloudflare_deployment_id && deployment.cloudflare_project_name) {
    try {
      await CloudflarePages.cancelDeployment(
        deployment.cloudflare_project_name,
        deployment.cloudflare_deployment_id
      );
    } catch {
      // Ignore — deployment may already be gone
    }
  }

  // Clean up R2 object if present
  if (deployment.r2_object_key) {
    try {
      await R2.deleteObject(deployment.r2_object_key);
    } catch {
      // Ignore cleanup failures
    }
  }

  await runtimePool.query(`DELETE FROM app_deployments WHERE id = $1`, [deploymentId]);
}

/**
 * Remove a Cloudflare Pages project and its associated custom domain / DNS record.
 * Best-effort: errors are logged but never thrown.
 */
async function cleanupCloudflareProject(
  runtimePool: Pool,
  appId: string,
  projectName: string
): Promise<void> {
  const appRow = await runtimePool.query(
    `SELECT subdomain FROM apps WHERE id = $1`,
    [appId]
  );
  const subdomain = appRow.rows[0]?.subdomain as string | undefined;
  const customDomain = subdomain && config.subdomain.baseDomain
    ? `${subdomain}.${config.subdomain.baseDomain}`
    : null;

  if (customDomain) {
    try {
      await CloudflarePages.removeCustomDomain(projectName, customDomain);
    } catch (error) {
      console.warn(`Failed to remove custom domain ${customDomain} from ${projectName}:`, error);
    }
  }

  try {
    await CloudflarePages.deleteProject(projectName);
  } catch (error) {
    console.warn(`Failed to delete Cloudflare project ${projectName}:`, error);
  }

  if (customDomain) {
    try {
      await CloudflarePages.deleteDnsRecord(customDomain);
    } catch (error) {
      console.warn(`Failed to delete DNS record for ${customDomain}:`, error);
    }
  }
}

/**
 * Remove all Cloudflare resources for an app. Branches on
 * apps.deployment_backend:
 *   - 'pages': iterates cloudflare_project_name rows (existing behavior).
 *   - 'wfp':   deletes the KV subdomain mapping and the user worker in
 *              the dispatch namespace. Tolerates 404 on the worker delete
 *              because apps that were init'd but never deployed for real
 *              have no user-script.
 *
 * Called before the app row is deleted so we can still read
 * app_deployments / apps. Best-effort: failures are logged but do not
 * block the app deletion.
 */
export async function deleteAppCloudflareResources(
  db: Pool,
  appId: string
): Promise<void> {
  if (!config.cloudflare.enabled) return;

  // Phase 2 single-region: derive runtime pool internally for runtime-tier tables
  const runtimePool = await getRuntimeDbForApp(db, appId);

  const appRow = await runtimePool.query<{ subdomain: string | null; deployment_backend: 'pages' | 'wfp' }>(
    `SELECT subdomain, deployment_backend FROM apps WHERE id = $1`,
    [appId]
  );
  const subdomain = appRow.rows[0]?.subdomain ?? null;
  const backend = appRow.rows[0]?.deployment_backend ?? 'pages';

  if (backend === 'wfp') {
    await cleanupWfpResources(runtimePool, appId, subdomain);
    return;
  }

  const projectRows = await runtimePool.query(
    `SELECT DISTINCT cloudflare_project_name
     FROM app_deployments
     WHERE app_id = $1 AND cloudflare_project_name IS NOT NULL`,
    [appId]
  );

  for (const row of projectRows.rows) {
    await cleanupCloudflareProject(runtimePool, appId, row.cloudflare_project_name);
  }
}

/**
 * Cleanup for a WfP app: remove the KV pointer (so the subdomain stops
 * resolving) and best-effort delete the user script. A 404 on the worker
 * delete means the app was init'd but never got a real frontend deploy —
 * swallow it.
 */
async function cleanupWfpResources(
  runtimePool: Pool,
  appId: string,
  subdomain: string | null
): Promise<void> {
  if (subdomain) {
    try {
      await CloudflareWfp.deleteSubdomainMapping(subdomain);
    } catch (error) {
      console.warn(`Failed to delete KV subdomain mapping for ${subdomain}:`, error);
    }
  }

  // Clean up custom domain resources (CF custom hostnames + KV domain mappings)
  // app_custom_domains is runtime-tier
  try {
    const domains = await runtimePool.query<{ hostname: string; cf_custom_hostname_id: string | null }>(
      'SELECT hostname, cf_custom_hostname_id FROM app_custom_domains WHERE app_id = $1',
      [appId],
    );
    for (const d of domains.rows) {
      try {
        await CloudflareWfp.deleteDomainMapping(d.hostname);
      } catch (error) {
        console.warn(`Failed to delete KV domain mapping for ${d.hostname}:`, error);
      }
      if (d.cf_custom_hostname_id) {
        try {
          await CustomHostnames.deleteCustomHostname(d.cf_custom_hostname_id);
        } catch (error) {
          console.warn(`Failed to delete CF custom hostname for ${d.hostname}:`, error);
        }
      }
    }
  } catch (error) {
    console.warn(`Failed to clean up custom domains for ${appId}:`, error);
  }

  try {
    await CloudflareWfp.deleteUserWorker(appId);
  } catch (error) {
    const msg = error instanceof Error ? error.message : '';
    if (/\(404\)/.test(msg) || /script not found/i.test(msg) || /\b10007\b/.test(msg)) {
      // fall through to DO cleanup
    } else {
      console.warn(`Failed to delete WfP user worker for ${appId}:`, error);
    }
  }

  // Tear down the DO sibling script (`${appId}_do`) if it exists. Most apps
  // never register a DO, so a 404 here is expected — swallow it tolerantly.
  try {
    await CloudflareWfp.deleteDoWorker(`${appId}_do`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : '';
    if (/\(404\)/.test(msg) || /script not found/i.test(msg) || /\b10007\b/.test(msg)) {
      return;
    }
    console.warn(`Failed to delete WfP DO worker for ${appId}_do:`, error);
  }
}
