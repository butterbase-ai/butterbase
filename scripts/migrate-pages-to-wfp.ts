/**
 * Migrate a single Cloudflare Pages app to Workers for Platforms (WfP).
 *
 * Steps:
 *   1. Find the app in the control DB by subdomain
 *   2. Get its latest READY Pages deployment
 *   3. Download the deployed files from the pages.dev URL
 *   4. Deploy files to WfP
 *   5. Write KV subdomain → appId mapping
 *   6. Update apps.deployment_backend to 'wfp'
 *
 * Usage:
 *   CONTROL_DB_URL=... CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... \
 *   CLOUDFLARE_SUBDOMAIN_KV_ID=... AUTH_ENCRYPTION_KEY=... \
 *   npx tsx scripts/migrate-pages-to-wfp.ts <subdomain>
 *
 * Add --dry-run to see what would happen without making changes.
 */
import pg from 'pg';
import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Config (mirrors the service's config.ts but standalone)
// ---------------------------------------------------------------------------
const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID!;
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN!;
const DISPATCH_NS = process.env.CLOUDFLARE_DISPATCH_NAMESPACE ?? 'bb-frontends';
const KV_ID = process.env.CLOUDFLARE_SUBDOMAIN_KV_ID!;
// Phase 2: single-region — apps, app_deployments, app_frontend_env_vars are runtime tables.
const RUNTIME_DB_URL =
  process.env.NEON_RUNTIME_PROJECT_ID_US_EAST_1 ??
  process.env.CONTROL_DB_URL ??
  'postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control';
const AUTH_ENCRYPTION_KEY = process.env.AUTH_ENCRYPTION_KEY ?? '';

const CF_BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}`;

const DRY_RUN = process.argv.includes('--dry-run');
const subdomain = process.argv.find((a) => !a.startsWith('-') && a !== process.argv[0] && a !== process.argv[1]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function cfHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${API_TOKEN}` };
}

async function cfFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const url = path.startsWith('http') ? path : `${CF_BASE}${path}`;
  const headers: Record<string, string> = {
    ...cfHeaders(),
    ...(init.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
    ...(init.headers as Record<string, string> ?? {}),
  };
  const res = await fetch(url, { ...init, headers });
  const text = await res.text();
  let body: { success: boolean; errors: { code: number; message: string }[]; result: T };
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`CF API (${res.status}) ${path}: non-JSON: ${text.slice(0, 300)}`);
  }
  if (!body.success) {
    const msg = body.errors?.map((e) => `[${e.code}] ${e.message}`).join('; ') ?? res.statusText;
    throw new Error(`CF API (${res.status}) ${path}: ${msg}`);
  }
  return body.result;
}

function hash32(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 32);
}

function decrypt(encrypted: string, keyHex: string): string {
  const [ivB64, ciphertextB64, authTagB64] = encrypted.split(':');
  const key = Buffer.from(keyHex, 'hex');
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(authTagB64, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(ciphertextB64, 'base64', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// ---------------------------------------------------------------------------
// Step 1: Find app in DB
// ---------------------------------------------------------------------------
interface AppRow {
  id: string;
  name: string;
  subdomain: string;
  deployment_backend: string;
  cloudflare_project_name: string | null;
}

interface DeploymentRow {
  id: string;
  cloudflare_project_name: string;
  cloudflare_deployment_id: string;
  deployment_url: string;
  file_count: number;
}

async function findApp(pool: pg.Pool, sub: string): Promise<AppRow> {
  const { rows } = await pool.query<AppRow>(
    `SELECT id, name, subdomain, deployment_backend, cloudflare_project_name
     FROM apps WHERE subdomain = $1`,
    [sub],
  );
  if (rows.length === 0) throw new Error(`No app found with subdomain "${sub}"`);
  return rows[0];
}

async function getLatestReadyDeployment(pool: pg.Pool, appId: string): Promise<DeploymentRow> {
  const { rows } = await pool.query<DeploymentRow>(
    `SELECT id, cloudflare_project_name, cloudflare_deployment_id, deployment_url, file_count
     FROM app_deployments
     WHERE app_id = $1 AND status = 'READY' AND cloudflare_project_name IS NOT NULL
     ORDER BY completed_at DESC
     LIMIT 1`,
    [appId],
  );
  if (rows.length === 0) throw new Error(`No READY Pages deployment found for app ${appId}`);
  return rows[0];
}

// ---------------------------------------------------------------------------
// Step 2: Download files from Pages
// ---------------------------------------------------------------------------

/**
 * Walk the Cloudflare Pages file tree (API returns a nested object with
 * `id` = content hash for leaves). Collects all leaf paths.
 */
function collectPaths(tree: unknown, prefix = ''): string[] {
  if (!tree || typeof tree !== 'object') return [];
  const paths: string[] = [];

  // Handle both array format and object/tree format
  if (Array.isArray(tree)) {
    for (const entry of tree) {
      if (typeof entry === 'string') {
        paths.push(entry);
      } else if (entry && typeof entry === 'object' && 'path' in entry) {
        paths.push((entry as { path: string }).path);
      }
    }
    return paths;
  }

  for (const [key, value] of Object.entries(tree as Record<string, unknown>)) {
    if (key === 'id' || key === 'hash' || key === 'size') continue;
    const fullPath = prefix ? `${prefix}/${key}` : `/${key}`;

    if (value && typeof value === 'object') {
      const v = value as Record<string, unknown>;
      // Leaf node: has an `id` or `hash` field (it's a file, not a directory)
      if ('id' in v || 'hash' in v) {
        paths.push(fullPath);
      } else if ('children' in v) {
        paths.push(...collectPaths(v.children, fullPath));
      } else {
        // Could be a directory with nested entries
        paths.push(...collectPaths(v, fullPath));
      }
    }
  }
  return paths;
}

async function listPagesFiles(projectName: string, deploymentId: string): Promise<string[]> {
  console.log(`  Fetching file tree from CF Pages API…`);
  const tree = await cfFetch<unknown>(
    `/pages/projects/${projectName}/deployments/${deploymentId}/files`,
  );
  const paths = collectPaths(tree);
  if (paths.length === 0) {
    // Fallback: log the raw response so we can debug
    console.log(`  Raw file tree response:`, JSON.stringify(tree, null, 2).slice(0, 2000));
    throw new Error('Could not parse any file paths from the Pages deployment file tree');
  }
  return paths;
}

async function downloadFromPages(
  pagesProjectName: string,
  filePaths: string[],
): Promise<Map<string, Buffer>> {
  const baseUrl = `https://${pagesProjectName}.pages.dev`;
  const files = new Map<string, Buffer>();
  let downloaded = 0;
  let failed = 0;

  for (const p of filePaths) {
    const url = `${baseUrl}${p}`;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        console.warn(`    SKIP ${p} — HTTP ${res.status}`);
        failed++;
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      files.set(p, buf);
      downloaded++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`    SKIP ${p} — ${msg}`);
      failed++;
    }
  }

  console.log(`  Downloaded ${downloaded} files (${failed} skipped)`);
  return files;
}

// ---------------------------------------------------------------------------
// Step 3: Deploy to WfP
// ---------------------------------------------------------------------------

// Import the canonical worker script from the WfP module so both paths stay in sync.
// We inline it here for the migration script since it runs standalone.
const WORKER_JS = `
const MIME = {
  js: 'application/javascript',
  mjs: 'application/javascript',
  css: 'text/css',
  html: 'text/html',
  htm: 'text/html',
  json: 'application/json',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  eot: 'application/vnd.ms-fontobject',
  wasm: 'application/wasm',
  xml: 'application/xml',
  txt: 'text/plain',
  map: 'application/json',
};

function withMime(req, res) {
  if (res.headers.get('content-type')) return res;
  const ext = req.url.split('?')[0].split('.').pop()?.toLowerCase();
  const ct = ext && MIME[ext];
  if (!ct) return res;
  const h = new Headers(res.headers);
  h.set('content-type', ct);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

export default {
  async fetch(request, env) {
    try {
      const res = await env.ASSETS.fetch(request);
      if (res.status !== 404) return withMime(request, res);
      const url = new URL(request.url);
      url.pathname = '/index.html';
      const fallback = await env.ASSETS.fetch(new Request(url.toString(), request));
      return withMime(new Request(url.toString()), fallback);
    } catch (err) {
      return new Response('worker error: ' + (err && err.message ? err.message : String(err)), { status: 500 });
    }
  }
};`;

async function deployToWfp(
  scriptName: string,
  files: Map<string, Buffer>,
  envVars: Record<string, string>,
): Promise<void> {
  // Build manifest
  const manifest: Record<string, { hash: string; size: number }> = {};
  const hashToContent: Record<string, Buffer> = {};
  for (const [p, content] of files) {
    const h = hash32(content);
    manifest[p] = { hash: h, size: content.length };
    hashToContent[h] = content;
  }

  // 1. Session
  console.log(`  Creating WfP upload session (${files.size} files)…`);
  const session = await cfFetch<{ jwt: string; buckets?: string[][] }>(
    `/workers/dispatch/namespaces/${DISPATCH_NS}/scripts/${scriptName}/assets-upload-session`,
    { method: 'POST', body: JSON.stringify({ manifest }) },
  );
  let completionToken = session.jwt;

  // 2. Upload buckets
  const buckets = session.buckets ?? [];
  console.log(`  Uploading ${buckets.length} bucket(s)…`);
  for (const bucket of buckets) {
    const form = new FormData();
    for (const h of bucket) {
      const content = hashToContent[h];
      if (!content) throw new Error(`CF asked to upload unknown hash: ${h}`);
      form.append(h, content.toString('base64'));
    }
    const res = await fetch(`${CF_BASE}/workers/assets/upload?base64=true`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.jwt}` },
      body: form,
    });
    const body = (await res.json()) as { success: boolean; result: { jwt?: string }; errors: unknown };
    if (!body.success) throw new Error(`Asset upload failed: ${JSON.stringify(body.errors)}`);
    if (body.result?.jwt) completionToken = body.result.jwt;
  }

  // 3. Deploy script
  console.log(`  Deploying worker script…`);
  const metadata = {
    main_module: 'worker.mjs',
    assets: {
      jwt: completionToken,
      config: { html_handling: 'auto-trailing-slash' },
    },
    bindings: [
      { type: 'assets', name: 'ASSETS' },
      ...Object.entries(envVars).map(([name, text]) => ({ type: 'plain_text', name, text })),
    ],
    compatibility_date: '2025-01-24',
  };

  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('worker.mjs', new Blob([WORKER_JS], { type: 'application/javascript+module' }), 'worker.mjs');

  await cfFetch(`/workers/dispatch/namespaces/${DISPATCH_NS}/scripts/${scriptName}`, {
    method: 'PUT',
    body: form,
  });

  console.log(`  Worker deployed as script "${scriptName}"`);
}

// ---------------------------------------------------------------------------
// Step 4: Write KV + update DB
// ---------------------------------------------------------------------------

async function writeKvMapping(sub: string, appId: string): Promise<void> {
  console.log(`  Writing KV sub:${sub} → ${appId}…`);
  await cfFetch(`/storage/kv/namespaces/${KV_ID}/values/sub:${sub}`, {
    method: 'PUT',
    body: appId,
    headers: { 'Content-Type': 'text/plain' },
  });
}

async function updateAppBackend(pool: pg.Pool, appId: string): Promise<void> {
  console.log(`  Updating apps.deployment_backend → 'wfp'…`);
  await pool.query(
    `UPDATE apps SET deployment_backend = 'wfp', updated_at = now() WHERE id = $1`,
    [appId],
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  if (!subdomain) {
    console.error('Usage: npx tsx scripts/migrate-pages-to-wfp.ts <subdomain> [--dry-run]');
    process.exit(1);
  }
  if (!ACCOUNT_ID || !API_TOKEN) {
    console.error('Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN');
    process.exit(1);
  }
  if (!KV_ID) {
    console.error('Set CLOUDFLARE_SUBDOMAIN_KV_ID');
    process.exit(1);
  }

  if (DRY_RUN) console.log('=== DRY RUN (no changes will be made) ===\n');

  // apps, app_deployments, app_frontend_env_vars are runtime tables
  const pool = new pg.Pool({ connectionString: RUNTIME_DB_URL, max: 2 });

  try {
    // 1. Find app
    console.log(`[1/6] Finding app with subdomain "${subdomain}"…`);
    const app = await findApp(pool, subdomain);
    console.log(`  Found: id=${app.id} name="${app.name}" backend=${app.deployment_backend}`);

    if (app.deployment_backend === 'wfp') {
      console.log('  App is already on WfP — nothing to do.');
      return;
    }

    // 2. Get latest Pages deployment
    console.log(`\n[2/6] Getting latest READY deployment…`);
    const deployment = await getLatestReadyDeployment(pool, app.id);
    console.log(`  Deployment: id=${deployment.id}`);
    console.log(`  Pages project: ${deployment.cloudflare_project_name}`);
    console.log(`  CF deployment: ${deployment.cloudflare_deployment_id}`);
    console.log(`  URL: ${deployment.deployment_url}`);
    console.log(`  File count: ${deployment.file_count}`);

    // 3. Download files from Pages
    console.log(`\n[3/6] Downloading files from Cloudflare Pages…`);
    const filePaths = await listPagesFiles(
      deployment.cloudflare_project_name,
      deployment.cloudflare_deployment_id,
    );
    console.log(`  Found ${filePaths.length} file(s): ${filePaths.slice(0, 10).join(', ')}${filePaths.length > 10 ? '…' : ''}`);

    const files = await downloadFromPages(deployment.cloudflare_project_name, filePaths);
    if (files.size === 0) throw new Error('No files downloaded — aborting');

    const totalBytes = [...files.values()].reduce((sum, b) => sum + b.length, 0);
    console.log(`  Total size: ${(totalBytes / 1024).toFixed(1)} KB`);

    if (DRY_RUN) {
      console.log('\n=== DRY RUN complete — would deploy these files to WfP ===');
      return;
    }

    // 4. Fetch env vars (only if they exist AND we have the decryption key)
    console.log(`\n[4/6] Loading environment variables…`);
    const envRows = await pool.query<{ key: string; encrypted_value: string }>(
      `SELECT key, encrypted_value FROM app_frontend_env_vars WHERE app_id = $1`,
      [app.id],
    );
    const envVars: Record<string, string> = {};
    if (envRows.rows.length > 0 && !AUTH_ENCRYPTION_KEY) {
      console.warn(`  ⚠ App has ${envRows.rows.length} env var(s) but AUTH_ENCRYPTION_KEY is not set — deploying WITHOUT env vars`);
    } else {
      for (const row of envRows.rows) {
        envVars[row.key] = decrypt(row.encrypted_value, AUTH_ENCRYPTION_KEY);
      }
    }
    console.log(`  ${Object.keys(envVars).length} env var(s) loaded`);

    // 5. Deploy to WfP
    console.log(`\n[5/6] Deploying to Workers for Platforms…`);
    await deployToWfp(app.id, files, envVars);

    // 6. Write KV + update DB
    console.log(`\n[6/6] Writing KV mapping and updating DB…`);
    await writeKvMapping(subdomain, app.id);
    await updateAppBackend(pool, app.id);

    console.log(`\n=== Migration complete ===`);
    console.log(`  App "${app.name}" (${app.id}) is now on WfP`);
    console.log(`  Site: https://${subdomain}.butterbase.dev`);
    console.log(`  Old Pages project "${deployment.cloudflare_project_name}" is still alive (delete manually when ready)`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('\nFATAL:', err.message ?? err);
  process.exit(1);
});
