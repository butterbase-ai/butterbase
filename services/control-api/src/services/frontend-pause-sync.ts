// Keeps the dispatch worker's KV routes in step with apps.paused, so a
// paused app's frontend serves the paused page (spec §5.6). It only flips
// `paused` on keys that already exist and keeps their appId/region: a
// template's sub: key points at __placeholder__, and an app with no
// frontend must not gain a route.
import type pg from 'pg';
import { config } from '../config.js';
import { onPauseStateChanged } from './app-pause.js';
import { getRuntimeDbForApp } from './region-resolver.js';
import { readKvMapping, writeDomainMapping, writeSubdomainMapping } from './cloudflare-wfp.js';

type Db = Pick<pg.Pool, 'query'>;

function parseExisting(raw: string, fallbackRegion: string): { appId: string; region: string } {
  if (raw.startsWith('{')) {
    try {
      const v = JSON.parse(raw);
      if (v.appId) return { appId: v.appId, region: v.region ?? fallbackRegion };
    } catch { /* legacy value */ }
  }
  return { appId: raw, region: fallbackRegion };
}

export async function syncFrontendPausedState(controlDb: Db, appId: string): Promise<{ rewritten: string[] }> {
  const rewritten: string[] = [];
  if (!config.cloudflare.subdomainKvId && !process.env.KV_LOCAL_FILE) return { rewritten };

  const runtimeDb = await getRuntimeDbForApp(controlDb as pg.Pool, appId);
  const app = (await runtimeDb.query(
    `SELECT subdomain, region, paused, deployment_backend FROM apps WHERE id = $1`, [appId],
  )).rows[0] as { subdomain: string | null; region: string; paused: boolean; deployment_backend: string } | undefined;
  if (!app || app.deployment_backend !== 'wfp') return { rewritten };

  const domains = (await runtimeDb.query(
    `SELECT hostname FROM app_custom_domains WHERE app_id = $1 AND archived_after_move IS NULL`, [appId],
  )).rows as { hostname: string }[];

  if (app.subdomain) {
    const key = `sub:${app.subdomain}`;
    const raw = await readKvMapping(key);
    if (raw !== null) {
      const cur = parseExisting(raw, app.region);
      await writeSubdomainMapping(app.subdomain, cur.appId, cur.region, app.paused);
      rewritten.push(key);
    }
  }
  for (const { hostname } of domains) {
    const key = `domain:${hostname}`;
    const raw = await readKvMapping(key);
    if (raw === null) continue;
    const cur = parseExisting(raw, app.region);
    await writeDomainMapping(hostname, cur.appId, cur.region, app.paused);
    rewritten.push(key);
  }
  return { rewritten };
}

/** Register once at startup. Errors are logged by notifyPauseStateChanged. */
export function registerFrontendPauseSync(controlDb: Db): () => void {
  return onPauseStateChanged(async ({ appId }) => { await syncFrontendPausedState(controlDb, appId); });
}
