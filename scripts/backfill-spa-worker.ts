#!/usr/bin/env tsx
/**
 * Re-uploads the per-app static frontend worker for every WfP-backed app,
 * using the artifact stored at R2.appArtifactKey(appId). The worker SOURCE is
 * the current STATIC_FALLBACK_WORKER_JS in cloudflare-wfp.ts — re-running the
 * upload applies in-source worker changes (e.g. the SPA fallback `/` fix in
 * PR #33) to already-deployed apps without forcing each app owner to redeploy.
 *
 * Assets are content-addressed and dedup'd by Cloudflare; in practice this
 * only changes worker.mjs, not the asset bytes. CF returns empty bucket lists
 * when all hashes are already stored, so this is fast per app.
 *
 * Skips:
 *   - Apps with deployment_backend != 'wfp' (only WfP uses STATIC_FALLBACK_WORKER_JS)
 *   - Apps with no R2 artifact slot (never deployed, or pre-artifact-slot apps)
 *   - Apps currently mid-deploy (status='BUILDING') — avoid stomping
 *
 * Required env:
 *   BUTTERBASE_REGIONS                          e.g. "us-east-1,eu-west-1"
 *   NEON_RUNTIME_PROJECT_ID_<REGION>            connection string per region
 *   AUTH_ENCRYPTION_KEY                         for app_frontend_env_vars
 *   CF_ACCOUNT_ID, CF_API_TOKEN                 Cloudflare API
 *   CF_DISPATCH_NAMESPACE                       e.g. "bb-frontends"
 *   R2_*                                        whatever r2.ts needs at runtime
 *
 * Usage:
 *   tsx scripts/backfill-spa-worker.ts --dry-run                  # default; lists only
 *   tsx scripts/backfill-spa-worker.ts --app-id app_xxx           # single app
 *   tsx scripts/backfill-spa-worker.ts --all                      # full backfill
 *   tsx scripts/backfill-spa-worker.ts --all --concurrency 4
 *
 * To run inside the deployed platform image (where src/ is absent and only
 * dist/ is present), copy this script to the Fly machine and rewrite the
 * three `../services/control-api/src/services/*.js` imports to point at
 * `/app/submodules/butterbase-oss/services/control-api/dist/services/*.js`
 * before invoking via `node /tmp/backfill.mjs ...`. The script is otherwise
 * identical. This indirection exists because the production Dockerfile does
 * not COPY scripts/; running locally against tsx is the canonical path.
 */
import pg from 'pg';
import AdmZip from 'adm-zip';
import { deployUserWorker } from '../services/control-api/src/services/cloudflare-wfp.js';
import * as R2 from '../services/control-api/src/services/r2.js';
import { decrypt } from '../services/control-api/src/services/crypto.js';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run') || (!args.includes('--all') && !args.includes('--app-id'));
const ALL = args.includes('--all');
const SINGLE_APP_ID = (() => {
  const i = args.indexOf('--app-id');
  return i >= 0 ? args[i + 1] : null;
})();
const CONCURRENCY = (() => {
  const i = args.indexOf('--concurrency');
  return i >= 0 ? Math.max(1, parseInt(args[i + 1] ?? '3', 10)) : 3;
})();

if (!ALL && !SINGLE_APP_ID && !DRY_RUN) {
  console.error('Refusing to run: pass --all, --app-id <id>, or --dry-run');
  process.exit(2);
}

interface AppRow {
  id: string;
  name: string;
  subdomain: string | null;
  deployment_backend: 'pages' | 'wfp';
  region: string;
}

interface BackfillResult {
  appId: string;
  status: 'OK' | 'SKIPPED' | 'ERROR';
  reason?: string;
  ms?: number;
}

function envKeyFor(region: string): string {
  return `NEON_RUNTIME_PROJECT_ID_${region.toUpperCase().replace(/-/g, '_')}`;
}

async function loadAppsByRegion(): Promise<Map<string, { app: AppRow; pool: pg.Pool }>> {
  const regions = (process.env.BUTTERBASE_REGIONS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (regions.length === 0) throw new Error('BUTTERBASE_REGIONS is empty');

  const out = new Map<string, { app: AppRow; pool: pg.Pool }>();
  for (const region of regions) {
    const url = process.env[envKeyFor(region)];
    if (!url) {
      console.warn(`[skip] region=${region}: ${envKeyFor(region)} not set`);
      continue;
    }
    const pool = new pg.Pool({ connectionString: url });
    const where = SINGLE_APP_ID
      ? `WHERE id = $1 AND deployment_backend = 'wfp'`
      : `WHERE deployment_backend = 'wfp'`;
    const params = SINGLE_APP_ID ? [SINGLE_APP_ID] : [];
    const { rows } = await pool.query<AppRow>(
      `SELECT id, name, subdomain, deployment_backend, region FROM apps ${where}`,
      params,
    );
    for (const r of rows) out.set(r.id, { app: r, pool });
    console.log(`[load] region=${region}: ${rows.length} wfp apps`);
  }
  return out;
}

async function fetchAppArtifact(appId: string): Promise<Buffer | null> {
  const key = R2.appArtifactKey(appId);
  const head = await R2.head(key);
  if (!head.exists) return null;
  return await R2.getObjectAsBuffer(key);
}

async function fetchEnvVars(pool: pg.Pool, appId: string): Promise<Record<string, string>> {
  const encKey = process.env.AUTH_ENCRYPTION_KEY;
  if (!encKey) throw new Error('AUTH_ENCRYPTION_KEY not set');
  const { rows } = await pool.query<{ key: string; encrypted_value: string }>(
    `SELECT key, encrypted_value FROM app_frontend_env_vars WHERE app_id = $1`,
    [appId],
  );
  const out: Record<string, string> = {};
  for (const row of rows) out[row.key] = decrypt(row.encrypted_value, encKey);
  return out;
}

async function isDeployInProgress(pool: pg.Pool, appId: string): Promise<boolean> {
  const { rows } = await pool.query<{ status: string }>(
    `SELECT status FROM app_deployments
     WHERE app_id = $1 AND status IN ('BUILDING','PENDING','UPLOADING')
     LIMIT 1`,
    [appId],
  );
  return rows.length > 0;
}

function extractFiles(zipBuffer: Buffer): Map<string, Buffer> {
  const zip = new AdmZip(zipBuffer);
  const files = new Map<string, Buffer>();
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const path = entry.entryName.startsWith('/') ? entry.entryName : `/${entry.entryName}`;
    files.set(path.replace(/\\/g, '/'), entry.getData());
  }
  return files;
}

async function backfillOne(appId: string, pool: pg.Pool): Promise<BackfillResult> {
  const t0 = Date.now();
  try {
    if (await isDeployInProgress(pool, appId)) {
      return { appId, status: 'SKIPPED', reason: 'deploy in progress' };
    }
    const zipBuffer = await fetchAppArtifact(appId);
    if (!zipBuffer) {
      return { appId, status: 'SKIPPED', reason: 'no R2 artifact slot' };
    }
    const files = extractFiles(zipBuffer);
    if (files.size === 0) {
      return { appId, status: 'SKIPPED', reason: 'empty artifact' };
    }
    const envVars = await fetchEnvVars(pool, appId);

    if (DRY_RUN) {
      return {
        appId,
        status: 'SKIPPED',
        reason: `dry-run (would re-upload ${files.size} files, ${Object.keys(envVars).length} env vars)`,
        ms: Date.now() - t0,
      };
    }

    await deployUserWorker({ scriptName: appId, files, envVars });
    return { appId, status: 'OK', ms: Date.now() - t0 };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { appId, status: 'ERROR', reason: msg, ms: Date.now() - t0 };
  }
}

async function withConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
  onResult: (r: R) => void,
): Promise<void> {
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      const r = await fn(items[i]);
      onResult(r);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

async function main() {
  console.log(`[backfill-spa-worker] mode=${DRY_RUN ? 'DRY_RUN' : (SINGLE_APP_ID ? 'SINGLE' : 'ALL')} concurrency=${CONCURRENCY}`);
  const apps = await loadAppsByRegion();
  const appIds = [...apps.keys()];
  console.log(`[backfill-spa-worker] ${appIds.length} candidate app(s)`);
  if (appIds.length === 0) return;

  const results: BackfillResult[] = [];
  const counts = { OK: 0, SKIPPED: 0, ERROR: 0 };
  let done = 0;

  await withConcurrency(
    appIds,
    CONCURRENCY,
    (id) => backfillOne(id, apps.get(id)!.pool),
    (r) => {
      results.push(r);
      counts[r.status]++;
      done++;
      const label = r.status.padEnd(7);
      const tail = r.reason ? ` — ${r.reason}` : '';
      const ms = r.ms != null ? ` (${r.ms}ms)` : '';
      console.log(`[${done}/${appIds.length}] ${label} ${r.appId}${ms}${tail}`);
    },
  );

  console.log('\n[summary]');
  console.log(`  OK:      ${counts.OK}`);
  console.log(`  SKIPPED: ${counts.SKIPPED}`);
  console.log(`  ERROR:   ${counts.ERROR}`);
  if (counts.ERROR > 0) {
    console.log('\n[errors]');
    for (const r of results.filter((x) => x.status === 'ERROR')) {
      console.log(`  ${r.appId}: ${r.reason}`);
    }
    process.exit(1);
  }

  // Close all pools
  const pools = new Set([...apps.values()].map((v) => v.pool));
  for (const p of pools) await p.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
