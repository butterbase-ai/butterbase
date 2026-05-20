#!/usr/bin/env npx tsx
/**
 * migrate-pages-to-wfp.ts
 *
 * One-off migration: moves all apps with deployment_backend='pages' over to
 * the Workers-for-Platforms (wfp) backend so the dispatch worker can route
 * their *.butterbase.dev subdomains via KV.
 *
 * Strategy per app
 * ─────────────────
 * 1. Write sub:<subdomain> → __placeholder__ to KV immediately.
 *    This restores the subdomain (currently broken) right away, even if the
 *    full re-deploy hasn't happened yet.
 *
 * 2. Find the most recent deployment whose R2 object still exists.
 *    Successful Pages deployments delete the zip from R2 after uploading to
 *    CF Pages, so the zip is usually gone. But WAITING/UPLOADING deployments
 *    (upload done, start never triggered) still have their zip in R2.
 *
 * 3. If a zip is found: deploy to WfP dispatch namespace, then update the KV
 *    entry from __placeholder__ → app_id so traffic hits real content.
 *
 * 4. Flip apps.deployment_backend = 'wfp' and clear cloudflare_project_name
 *    (no longer relevant for WfP apps).
 *
 * The script is idempotent: re-running it skips apps that are already 'wfp'.
 *
 * Usage
 * ─────
 * From services/control-api/:
 *   npx tsx scripts/migrate-pages-to-wfp.ts [--dry-run]
 *
 * Required env vars (same set as the production control-api process):
 *   CONTROL_DB_URL
 *   CLOUDFLARE_ACCOUNT_ID
 *   CLOUDFLARE_API_TOKEN
 *   CLOUDFLARE_SUBDOMAIN_KV_ID
 *   CLOUDFLARE_DISPATCH_NAMESPACE
 *   S3_BUCKET_NAME
 *   S3_ENDPOINT
 *   AWS_ACCESS_KEY_ID
 *   AWS_SECRET_ACCESS_KEY
 *   AUTH_ENCRYPTION_KEY
 *   BASE_DOMAIN  (default: butterbase.dev)
 */

import { Pool } from 'pg';
import AdmZip from 'adm-zip';
import * as R2 from '../src/services/r2.js';
import * as CloudflareWfp from '../src/services/cloudflare-wfp.js';
import { decrypt } from '../src/services/crypto.js';
import { config } from '../src/config.js';

// ── CLI flags ──────────────────────────────────────────────────────────────
const DRY_RUN = process.argv.includes('--dry-run');

if (DRY_RUN) {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║  DRY RUN — no changes will be written    ║');
  console.log('╚══════════════════════════════════════════╝\n');
}

// ── DB connection ──────────────────────────────────────────────────────────
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

// ── Helpers ────────────────────────────────────────────────────────────────

/** Try to download an R2 object. Returns the Buffer on success, null if the
 *  object does not exist (404), throws on other errors. */
async function tryDownloadR2(objectKey: string): Promise<Buffer | null> {
  try {
    return await R2.downloadObjectAsBuffer(objectKey);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('not found') || msg.includes('NoSuchKey') || msg.includes('404')) {
      return null;
    }
    throw err;
  }
}

/** Fetch & decrypt env vars for an app (mirrors deployment.service.ts). */
async function getEnvVars(appId: string): Promise<Record<string, string>> {
  const encKey = process.env.AUTH_ENCRYPTION_KEY!;
  if (!encKey) return {}; // not fatal — just deploy without env vars
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

// ── Types ──────────────────────────────────────────────────────────────────

interface PagesApp {
  id: string;
  name: string;
  subdomain: string | null;
  cloudflare_project_name: string | null;
}

interface AppDeployment {
  id: string;
  status: string;
  r2_object_key: string | null;
  deployment_url: string | null;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  // Guard: CF must be configured
  if (!config.cloudflare.enabled) {
    console.error('✗ Cloudflare is not configured (CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN missing).');
    process.exit(1);
  }
  if (!config.cloudflare.subdomainKvId) {
    console.error('✗ CLOUDFLARE_SUBDOMAIN_KV_ID is not set.');
    process.exit(1);
  }

  // Fetch all Pages apps
  const appsResult = await db.query<PagesApp>(
    `SELECT id, name, subdomain, cloudflare_project_name
     FROM apps
     WHERE deployment_backend = 'pages'
     ORDER BY created_at`,
  );

  const apps = appsResult.rows;
  console.log(`Found ${apps.length} Pages app(s) to migrate.\n`);

  if (apps.length === 0) {
    console.log('Nothing to do.');
    await db.end();
    return;
  }

  const results: { app: string; outcome: string }[] = [];

  for (const app of apps) {
    const tag = `[${app.name} / ${app.id}]`;
    console.log(`\n${tag}`);
    console.log(`  subdomain: ${app.subdomain ?? '(none)'}`);

    // ── Step 1: Write placeholder KV immediately ───────────────────────────
    if (app.subdomain) {
      if (!DRY_RUN) {
        await CloudflareWfp.writeSubdomainMapping(
          app.subdomain,
          CloudflareWfp.PLACEHOLDER_SCRIPT_NAME,
        );
      }
      console.log(`  ✓ KV: sub:${app.subdomain} → __placeholder__ (routing restored)`);
    } else {
      console.log(`  — No subdomain, skipping KV write`);
    }

    // ── Step 2: Find the most recent deployment with a surviving R2 zip ────
    const deploymentsResult = await db.query<AppDeployment>(
      `SELECT id, status, r2_object_key, deployment_url
       FROM app_deployments
       WHERE app_id = $1 AND r2_object_key IS NOT NULL
       ORDER BY created_at DESC`,
      [app.id],
    );

    let deployed = false;

    for (const dep of deploymentsResult.rows) {
      console.log(`  Checking R2 for deployment ${dep.id} (status=${dep.status})…`);

      const zipBuf = await tryDownloadR2(dep.r2_object_key!);
      if (!zipBuf) {
        console.log(`    R2 object gone (already deleted after Pages deploy) — skipping`);
        continue;
      }

      console.log(`  ✓ R2 zip found (${(zipBuf.length / 1024).toFixed(0)} KB) — deploying to WfP…`);

      // ── Step 3: Extract & deploy to WfP ─────────────────────────────────
      if (!app.subdomain) {
        console.log(`  ⚠  Zip found but app has no subdomain — cannot map to WfP, skipping deploy`);
        break;
      }

      try {
        const zip = new AdmZip(zipBuf);
        const fileMap = new Map<string, Buffer>();
        for (const entry of zip.getEntries()) {
          if (!entry.isDirectory) {
            const p = entry.entryName.replace(/\\/g, '/');
            fileMap.set(p.startsWith('/') ? p : `/${p}`, entry.getData());
          }
        }

        if (fileMap.size === 0) {
          console.log(`  ⚠  Zip is empty — skipping deploy`);
          break;
        }

        const envVars = await getEnvVars(app.id);

        if (!DRY_RUN) {
          await CloudflareWfp.deployUserWorker({
            scriptName: app.id,
            files: fileMap,
            envVars,
          });

          // Replace placeholder with real app_id in KV
          await CloudflareWfp.writeSubdomainMapping(app.subdomain, app.id);

          // Mark this deployment as READY in DB
          const deploymentUrl = `https://${app.subdomain}.${config.subdomain.baseDomain}`;
          await db.query(
            `UPDATE app_deployments
             SET status = 'READY', deployment_url = $1,
                 cloudflare_project_name = NULL,
                 cloudflare_deployment_id = NULL,
                 completed_at = now(), updated_at = now()
             WHERE id = $2`,
            [deploymentUrl, dep.id],
          );
          await db.query(
            `UPDATE apps SET deployment_url = $1, last_deployed_at = now() WHERE id = $2`,
            [deploymentUrl, app.id],
          );
        }

        console.log(`  ✓ WfP deploy complete — KV: sub:${app.subdomain} → ${app.id}`);
        deployed = true;
        break; // First surviving zip is enough
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  ✗ WfP deploy failed: ${msg}`);
        console.log(`    Falling back to placeholder`);
        break;
      }
    }

    if (!deployed && app.subdomain) {
      console.log(`  ℹ  No R2 zip found — subdomain routes to placeholder. User must re-deploy to restore content.`);
    }

    // ── Step 4: Flip deployment_backend in DB ──────────────────────────────
    if (!DRY_RUN) {
      await db.query(
        `UPDATE apps
         SET deployment_backend = 'wfp',
             cloudflare_project_name = NULL,
             updated_at = now()
         WHERE id = $1`,
        [app.id],
      );
    }
    console.log(`  ✓ apps.deployment_backend = 'wfp'`);

    results.push({
      app: `${app.name} (${app.subdomain ?? 'no subdomain'})`,
      outcome: deployed ? 'MIGRATED (real content)' : app.subdomain ? 'MIGRATED (placeholder — needs re-deploy)' : 'MIGRATED (no subdomain)',
    });
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════');
  console.log('Migration summary:');
  for (const r of results) {
    console.log(`  ${r.app.padEnd(40)} ${r.outcome}`);
  }
  if (DRY_RUN) {
    console.log('\n(dry run — no changes were written)');
  }

  await db.end();
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
