#!/usr/bin/env tsx
/**
 * Backfills every legacy `sub:*` and `domain:*` KV entry from a raw appId string
 * to the new {"appId":..., "region":...} JSON format.
 *
 * Reads apps.region from each region's runtime DB. Idempotent.
 *
 * Usage:
 *   tsx scripts/backfill-kv-region.ts --dry-run
 *   tsx scripts/backfill-kv-region.ts          # actually writes
 */
import pg from 'pg';
import {
  writeSubdomainMapping,
  writeDomainMapping,
} from '../services/control-api/src/services/cloudflare-wfp.js';

const DRY_RUN = process.argv.includes('--dry-run');

async function listKvEntries(prefix: string): Promise<Array<{ name: string; value: string | null }>> {
  const cfAccount = process.env.CF_ACCOUNT_ID;
  const cfKv = process.env.CF_KV_NAMESPACE_ID;
  const cfToken = process.env.CF_API_TOKEN;
  if (!cfAccount || !cfKv || !cfToken) throw new Error('CF_ACCOUNT_ID, CF_KV_NAMESPACE_ID, CF_API_TOKEN required');

  const out: Array<{ name: string; value: string | null }> = [];
  let cursor: string | undefined;
  do {
    const url = new URL(`https://api.cloudflare.com/client/v4/accounts/${cfAccount}/storage/kv/namespaces/${cfKv}/keys`);
    url.searchParams.set('prefix', prefix);
    if (cursor) url.searchParams.set('cursor', cursor);
    const r = await fetch(url, { headers: { Authorization: `Bearer ${cfToken}` } });
    const body = await r.json() as { result: Array<{ name: string }>; result_info: { cursor?: string } };
    for (const k of body.result) {
      const valUrl = `https://api.cloudflare.com/client/v4/accounts/${cfAccount}/storage/kv/namespaces/${cfKv}/values/${encodeURIComponent(k.name)}`;
      const valRes = await fetch(valUrl, { headers: { Authorization: `Bearer ${cfToken}` } });
      const text = valRes.status === 200 ? await valRes.text() : null;
      out.push({ name: k.name, value: text });
    }
    cursor = body.result_info.cursor || undefined;
  } while (cursor);
  return out;
}

async function buildAppRegionMap(): Promise<Map<string, string>> {
  const regions = (process.env.BUTTERBASE_REGIONS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const map = new Map<string, string>();
  for (const region of regions) {
    const url = process.env[`NEON_RUNTIME_PROJECT_ID_${region.toUpperCase().replace(/-/g, '_')}`];
    if (!url) continue;
    const pool = new pg.Pool({ connectionString: url });
    try {
      const { rows } = await pool.query<{ id: string; region: string }>(`SELECT id, region FROM apps`);
      for (const row of rows) map.set(row.id, row.region);
    } finally {
      await pool.end();
    }
  }
  return map;
}

async function main() {
  const appRegion = await buildAppRegionMap();
  console.log(`[backfill-kv] indexed ${appRegion.size} apps from runtime DBs`);

  const subs = await listKvEntries('sub:');
  const domains = await listKvEntries('domain:');
  console.log(`[backfill-kv] subs=${subs.length}, domains=${domains.length}`);

  let rewritten = 0, skipped = 0, missing = 0;

  for (const e of subs) {
    if (!e.value) { skipped++; continue; }
    if (e.value.startsWith('{')) { skipped++; continue; }
    const region = appRegion.get(e.value);
    if (!region) {
      console.warn(`[backfill-kv] sub:${e.name.replace('sub:', '')} → appId ${e.value} has no apps row; skipping`);
      missing++;
      continue;
    }
    const subdomain = e.name.replace(/^sub:/, '');
    if (DRY_RUN) {
      console.log(`[dry] sub:${subdomain} = ${e.value} → {appId:${e.value},region:${region}}`);
    } else {
      await writeSubdomainMapping(subdomain, e.value, region);
      rewritten++;
    }
  }
  for (const e of domains) {
    if (!e.value) { skipped++; continue; }
    if (e.value.startsWith('{')) { skipped++; continue; }
    const region = appRegion.get(e.value);
    if (!region) { missing++; continue; }
    const hostname = e.name.replace(/^domain:/, '');
    if (DRY_RUN) {
      console.log(`[dry] domain:${hostname} = ${e.value} → {appId:${e.value},region:${region}}`);
    } else {
      await writeDomainMapping(hostname, e.value, region);
      rewritten++;
    }
  }

  console.log(`[backfill-kv] done — rewritten=${rewritten} skipped=${skipped} missing=${missing}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
