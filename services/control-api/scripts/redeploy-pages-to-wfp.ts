#!/usr/bin/env npx tsx
/**
 * redeploy-pages-to-wfp.ts
 *
 * For each app that was migrated from Pages → WfP (deployment_backend='wfp'
 * but still has a cloudflare_project_name in app_deployments), this script:
 *
 * 1. Calls the CF Pages API to get the latest production deployment URL.
 * 2. Fetches index.html from that URL and crawls all referenced static assets
 *    (JS, CSS, images, fonts, etc.).
 * 3. Re-deploys the collected files to the WfP dispatch namespace.
 * 4. Updates KV: sub:<subdomain> → app_id (replaces __placeholder__).
 * 5. Marks a deployment READY in the DB.
 *
 * Run from services/control-api/:
 *   npx tsx scripts/redeploy-pages-to-wfp.ts [--dry-run] [--app <app_id>]
 *
 * Uses the same env vars as the production control-api process (already set
 * when run via `fly ssh console`).
 */

import { Pool } from 'pg';
import * as cheerio from 'cheerio';
import * as CloudflareWfp from '../src/services/cloudflare-wfp.js';
import { decrypt } from '../src/services/crypto.js';
import { config } from '../src/config.js';

const DRY_RUN = process.argv.includes('--dry-run');
const ONLY_APP = (() => {
  const i = process.argv.indexOf('--app');
  return i !== -1 ? process.argv[i + 1] : null;
})();

if (DRY_RUN) {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║  DRY RUN — no changes will be written    ║');
  console.log('╚══════════════════════════════════════════╝\n');
}

// Phase 2: single-region — apps, app_deployments, app_frontend_env_vars are runtime tables.
const runtimeDbUrl =
  process.env.NEON_RUNTIME_PROJECT_ID_US_EAST_1 ??
  process.env.CONTROL_DB_URL ??
  config.controlDb.url;

const db = new Pool({
  connectionString: runtimeDbUrl,
  ssl: runtimeDbUrl.includes('sslmode=require')
    ? { rejectUnauthorized: false }
    : undefined,
});

// ── CF Pages API helpers ───────────────────────────────────────────────────

const CF_PAGES_BASE = `https://api.cloudflare.com/client/v4/accounts/${config.cloudflare.accountId}/pages/projects`;

function cfHeaders(): HeadersInit {
  return {
    Authorization: `Bearer ${config.cloudflare.apiToken}`,
    'Content-Type': 'application/json',
  };
}

interface CfPagesDeployment {
  id: string;
  url: string;
  environment: string;
  latest_stage: { name: string; status: string };
}

/** Get the latest production deployment URL for a Pages project. */
async function getLatestPagesDeploymentUrl(projectName: string): Promise<string | null> {
  const res = await fetch(
    `${CF_PAGES_BASE}/${projectName}/deployments?env=production&per_page=5`,
    { headers: cfHeaders() },
  );
  if (!res.ok) return null;
  const data = (await res.json()) as { result: CfPagesDeployment[] };
  const ready = data.result?.find(
    (d) => d.environment === 'production' && d.latest_stage?.status === 'success',
  );
  return ready?.url ?? null;
}

// ── Asset crawling ─────────────────────────────────────────────────────────

const SKIP_EXTENSIONS = new Set(['map']); // source maps — skip

function shouldSkip(pathname: string): boolean {
  const ext = pathname.split('.').pop()?.toLowerCase() ?? '';
  return SKIP_EXTENSIONS.has(ext);
}

/**
 * Crawl a static Pages deployment.
 * Fetches index.html, collects all <script src>, <link href>, <img src>,
 * and any manifest / _app / chunks references. Returns a Map of
 * absolute-path → Buffer.
 */
async function crawlDeployment(baseUrl: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  const queue: string[] = ['/index.html'];
  const visited = new Set<string>();

  async function fetchAsset(path: string): Promise<Buffer | null> {
    const url = `${baseUrl}${path}`;
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) return null;
      return Buffer.from(await res.arrayBuffer());
    } catch {
      return null;
    }
  }

  while (queue.length > 0) {
    const path = queue.shift()!;
    if (visited.has(path)) continue;
    visited.add(path);
    if (shouldSkip(path)) continue;

    const buf = await fetchAsset(path);
    if (!buf) continue;
    files.set(path, buf);

    const isHtml = path.endsWith('.html') || path === '/index.html';
    const isJs = path.endsWith('.js') || path.endsWith('.mjs');

    if (isHtml) {
      const html = buf.toString('utf8');
      const $ = cheerio.load(html);

      // <script src="...">
      $('script[src]').each((_, el) => {
        const src = $(el).attr('src') ?? '';
        if (src.startsWith('/') && !src.startsWith('//')) queue.push(src);
        else if (src.startsWith('./')) queue.push('/' + src.slice(2));
      });

      // <link href="..."> (stylesheets, preload, icons)
      $('link[href]').each((_, el) => {
        const href = $(el).attr('href') ?? '';
        if (href.startsWith('/') && !href.startsWith('//')) queue.push(href);
        else if (href.startsWith('./')) queue.push('/' + href.slice(2));
      });

      // <img src="...">
      $('img[src]').each((_, el) => {
        const src = $(el).attr('src') ?? '';
        if (src.startsWith('/') && !src.startsWith('//')) queue.push(src);
      });

      // Next.js: __NEXT_DATA__ → /_next/static/... references
      const nextData = html.match(/"_buildManifest":\s*"([^"]+)"/);
      if (nextData) queue.push(nextData[1]);
    }

    if (isJs) {
      const js = buf.toString('utf8');
      // Vite chunk imports: import("./foo-abc123.js") or "/assets/foo-abc123.js"
      const chunkRefs = js.matchAll(/["'](\/(assets|_next\/static)[^"']+\.(js|css|woff2?|ttf|otf|png|svg|webp))["']/g);
      for (const m of chunkRefs) queue.push(m[1]);
    }
  }

  // Always include 404.html if present (Next.js static)
  if (!files.has('/404.html')) {
    const buf = await fetchAsset('/404.html');
    if (buf) files.set('/404.html', buf);
  }

  return files;
}

// ── Env vars ───────────────────────────────────────────────────────────────

async function getEnvVars(appId: string): Promise<Record<string, string>> {
  const encKey = process.env.AUTH_ENCRYPTION_KEY ?? config.auth.encryptionKey;
  if (!encKey) return {};
  const rows = await db.query<{ key: string; encrypted_value: string }>(
    `SELECT key, encrypted_value FROM app_frontend_env_vars WHERE app_id = $1`,
    [appId],
  );
  const envVars: Record<string, string> = {};
  for (const row of rows.rows) {
    try {
      envVars[row.key] = decrypt(row.encrypted_value, encKey);
    } catch {
      console.warn(`    ⚠  Could not decrypt env var ${row.key} — skipping`);
    }
  }
  return envVars;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  if (!config.cloudflare.enabled) {
    console.error('✗ Cloudflare not configured.');
    process.exit(1);
  }

  // Find all wfp apps that still have a Pages project (candidates for re-deploy)
  const { rows: apps } = await db.query<{
    id: string;
    name: string;
    subdomain: string;
    cf_project: string;
    framework: string;
  }>(`
    SELECT DISTINCT ON (a.id)
      a.id,
      a.name,
      a.subdomain,
      d.cloudflare_project_name AS cf_project,
      d.framework
    FROM apps a
    JOIN app_deployments d ON d.app_id = a.id
    WHERE a.deployment_backend = 'wfp'
      AND a.subdomain IS NOT NULL
      AND d.cloudflare_project_name IS NOT NULL
      AND d.status IN ('READY', 'BUILDING')
      ${ONLY_APP ? `AND a.id = '${ONLY_APP}'` : ''}
    ORDER BY a.id, d.created_at DESC
  `);

  console.log(`Found ${apps.length} app(s) to re-deploy from CF Pages → WfP.\n`);

  const results: { app: string; outcome: string }[] = [];

  for (const app of apps) {
    const tag = `[${app.name} / ${app.id}]`;
    console.log(`\n${tag}`);
    console.log(`  subdomain : ${app.subdomain}`);
    console.log(`  CF project: ${app.cf_project}`);

    // ── Step 1: Get latest Pages deployment URL ────────────────────────────
    const pagesUrl = await getLatestPagesDeploymentUrl(app.cf_project);
    if (!pagesUrl) {
      console.log(`  ✗ No live Pages deployment found — skipping`);
      results.push({ app: app.name, outcome: 'SKIPPED (no Pages deployment)' });
      continue;
    }
    console.log(`  Pages URL : ${pagesUrl}`);

    // ── Step 2: Crawl static assets ────────────────────────────────────────
    console.log(`  Crawling assets…`);
    let fileMap: Map<string, Buffer>;
    try {
      fileMap = await crawlDeployment(pagesUrl);
    } catch (err) {
      console.error(`  ✗ Crawl failed: ${err instanceof Error ? err.message : err}`);
      results.push({ app: app.name, outcome: 'FAILED (crawl error)' });
      continue;
    }

    if (fileMap.size === 0) {
      console.log(`  ✗ No files found at ${pagesUrl} — skipping`);
      results.push({ app: app.name, outcome: 'SKIPPED (no files crawled)' });
      continue;
    }

    const totalKb = [...fileMap.values()].reduce((s, b) => s + b.length, 0) / 1024;
    console.log(`  Crawled ${fileMap.size} files (${totalKb.toFixed(0)} KB)`);
    for (const p of [...fileMap.keys()].slice(0, 10)) console.log(`    ${p}`);
    if (fileMap.size > 10) console.log(`    … and ${fileMap.size - 10} more`);

    // ── Step 3: Deploy to WfP ──────────────────────────────────────────────
    const envVars = await getEnvVars(app.id);

    if (!DRY_RUN) {
      try {
        await CloudflareWfp.deployUserWorker({
          scriptName: app.id,
          files: fileMap,
          envVars,
        });
      } catch (err) {
        console.error(`  ✗ WfP deploy failed: ${err instanceof Error ? err.message : err}`);
        results.push({ app: app.name, outcome: 'FAILED (WfP deploy error)' });
        continue;
      }

      // ── Step 4: Update KV → app_id ─────────────────────────────────────
      await CloudflareWfp.writeSubdomainMapping(app.subdomain, app.id);

      // ── Step 5: Record in DB ────────────────────────────────────────────
      const deploymentUrl = `https://${app.subdomain}.${config.subdomain.baseDomain}`;
      await db.query(
        `INSERT INTO app_deployments
           (app_id, framework, status, deployment_url,
            cloudflare_project_name, cloudflare_deployment_id,
            file_count, total_size_bytes, started_at, completed_at)
         VALUES ($1, $2, 'READY', $3, NULL, NULL, $4, $5, now(), now())`,
        [
          app.id,
          app.framework ?? 'other',
          deploymentUrl,
          fileMap.size,
          [...fileMap.values()].reduce((s, b) => s + b.length, 0),
        ],
      );
      await db.query(
        `UPDATE apps SET deployment_url = $1, last_deployed_at = now() WHERE id = $2`,
        [deploymentUrl, app.id],
      );
    }

    console.log(`  ✓ Re-deployed to WfP — KV: sub:${app.subdomain} → ${app.id}`);
    results.push({ app: `${app.name} (${app.subdomain})`, outcome: 'REDEPLOYED' });
  }

  console.log('\n══════════════════════════════════════════════════');
  console.log('Re-deploy summary:');
  for (const r of results) {
    console.log(`  ${r.app.padEnd(40)} ${r.outcome}`);
  }
  if (DRY_RUN) console.log('\n(dry run — no changes were written)');

  await db.end();
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
