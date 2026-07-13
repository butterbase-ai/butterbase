#!/usr/bin/env tsx
/**
 * Backfill: redeploy all apps with active Durable Objects so their DO Worker
 * picks up the new DO_DISPATCH binding + DO_INVOKER_URL/TOKEN env bundle
 * introduced by ctx.invokeDO.
 *
 * Background: on the ctx.invokeDO ship, control-api's bundleAndDeploy started
 * injecting a dispatch_namespace binding named DO_DISPATCH and two platform
 * env keys (DO_INVOKER_URL, DO_INVOKER_TOKEN) into every user DO Worker's
 * metadata. Existing DO scripts deployed before that ship do NOT have any of
 * these — they'll never gain them until their next bundleAndDeploy fires
 * (e.g. the user runs manage_durable_objects deploy again, or edits DO env).
 * This script forces a redeploy on each app so ctx.invoke / ctx.invokeDO
 * from inside DO code Just Works everywhere.
 *
 * Usage:
 *   BUTTERBASE_REGIONS=us-east-1,us-west-2 \
 *   CONTROL_DB_URL=<control> \
 *   NEON_RUNTIME_PROJECT_ID_US_EAST_1=<runtime-url> \
 *   NEON_RUNTIME_PROJECT_ID_US_WEST_2=<runtime-url> \
 *   DO_INVOKER_URL=... DO_INVOKER_TOKEN=... \
 *   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... \
 *   AUTH_ENCRYPTION_KEY=... \
 *     tsx scripts/backfill-do-invoker-env.ts          # dry-run (default)
 *     tsx scripts/backfill-do-invoker-env.ts --fix    # actually redeploy
 *     tsx scripts/backfill-do-invoker-env.ts --fix --app app_xyz
 *     tsx scripts/backfill-do-invoker-env.ts --fix --region us-east-1
 *
 * Environment: expects the SAME env the control-api process runs with in
 * prod (CF creds + region URLs + AES key + do-invoker URL/TOKEN so
 * config.doInvoker resolves). Simplest way: fly ssh into butterbase-platform,
 * `env > /tmp/env`, then run this script locally with `env $(cat /tmp/env)`
 * — or invoke it inside the Fly container directly.
 */
import pg from 'pg';

const FIX = process.argv.includes('--fix');
const APP_ARG_IDX = process.argv.indexOf('--app');
const APP_FILTER = APP_ARG_IDX >= 0 ? process.argv[APP_ARG_IDX + 1] : null;
const REGION_ARG_IDX = process.argv.indexOf('--region');
const REGION_FILTER = REGION_ARG_IDX >= 0 ? process.argv[REGION_ARG_IDX + 1] : null;

interface AppRow {
  app_id: string;
  active_class_count: number;
}

async function findAppsWithActiveDOs(pool: pg.Pool): Promise<AppRow[]> {
  const filterClause = APP_FILTER ? 'AND app_id = $1' : '';
  const params: unknown[] = APP_FILTER ? [APP_FILTER] : [];
  const r = await pool.query<AppRow>(
    `SELECT app_id, COUNT(*)::int AS active_class_count
       FROM app_durable_objects
      WHERE status = 'READY' ${filterClause}
      GROUP BY app_id
      ORDER BY app_id`,
    params,
  );
  return r.rows;
}

async function processRegion(
  region: string,
  runtimeUrl: string,
  controlPool: pg.Pool,
): Promise<{ found: number; redeployed: number; failed: number }> {
  const runtimePool = new pg.Pool({ connectionString: runtimeUrl });
  const stats = { found: 0, redeployed: 0, failed: 0 };
  try {
    const apps = await findAppsWithActiveDOs(runtimePool);
    stats.found = apps.length;
    console.log(`[${region}] ${apps.length} app(s) with active DOs`);

    if (!FIX) {
      for (const { app_id, active_class_count } of apps) {
        console.log(`  [${app_id}] ${active_class_count} class(es) — would redeploy`);
      }
      return stats;
    }

    // Lazy import so the script can dry-run without pulling in control-api
    // deps (crypto, cf-client, etc.).
    const { redeployIfActive } = await import(
      '../services/control-api/src/services/durable-objects.service.js'
    );

    for (const { app_id, active_class_count } of apps) {
      process.stdout.write(`  [${app_id}] ${active_class_count} class(es) — redeploying… `);
      try {
        const started = Date.now();
        const didRedeploy = await redeployIfActive(runtimePool, controlPool, app_id);
        if (didRedeploy) {
          stats.redeployed++;
          console.log(`ok (${Date.now() - started}ms)`);
        } else {
          console.log(`skipped (no active classes)`);
        }
      } catch (err) {
        stats.failed++;
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`FAIL: ${msg}`);
      }
    }
  } finally {
    await runtimePool.end();
  }
  return stats;
}

async function main(): Promise<void> {
  const controlUrl = process.env.CONTROL_DB_URL;
  if (!controlUrl) throw new Error('CONTROL_DB_URL is required');

  const regionsRaw = (process.env.BUTTERBASE_REGIONS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const regions = REGION_FILTER
    ? regionsRaw.filter(r => r === REGION_FILTER)
    : regionsRaw;
  if (regions.length === 0) {
    throw new Error(REGION_FILTER
      ? `BUTTERBASE_REGIONS does not include --region ${REGION_FILTER}`
      : 'BUTTERBASE_REGIONS is empty');
  }

  console.log(`mode: ${FIX ? 'APPLY (real redeploy)' : 'dry-run'}`);
  if (APP_FILTER) console.log(`app filter: ${APP_FILTER}`);
  if (REGION_FILTER) console.log(`region filter: ${REGION_FILTER}`);

  if (FIX && !process.env.CLOUDFLARE_API_TOKEN) {
    throw new Error('--fix requires CLOUDFLARE_API_TOKEN (each redeploy PUTs to CF)');
  }
  if (FIX && !process.env.DO_INVOKER_URL) {
    console.warn('WARNING: DO_INVOKER_URL not set — redeployed DOs will NOT get the invoker env keys. Set DO_INVOKER_URL + DO_INVOKER_TOKEN before running with --fix if you want a full backfill.');
  }

  const controlPool = new pg.Pool({ connectionString: controlUrl });
  let totalFound = 0, totalRedeployed = 0, totalFailed = 0;

  try {
    for (const region of regions) {
      const urlVar = `NEON_RUNTIME_PROJECT_ID_${region.toUpperCase().replace(/-/g, '_')}`;
      const url = process.env[urlVar];
      if (!url) {
        console.warn(`[${region}] no ${urlVar}; skipping`);
        continue;
      }
      const s = await processRegion(region, url, controlPool);
      totalFound += s.found;
      totalRedeployed += s.redeployed;
      totalFailed += s.failed;
    }
  } finally {
    await controlPool.end();
  }

  console.log(`\nsummary: ${totalFound} app(s) with active DOs, ${totalRedeployed} redeployed, ${totalFailed} failed`);
  if (!FIX && totalFound > 0) {
    console.log('(run with --fix to actually redeploy)');
  }
  if (totalFailed > 0) process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
