/**
 * reconcile-worker.ts — Daily KV storage-counter reconciliation.
 *
 * Iterates all apps that have KV credentials (app_kv_credentials) and calls
 * reconcileFromScan on each to correct any counter drift from crashes or
 * missed decrements. Logs a warning when drift exceeds 5%.
 *
 * Started via startKvReconcileWorker() in index.ts after the server is ready.
 * The returned NodeJS.Timeout should be stored and cleared on graceful shutdown.
 *
 * Default interval: 24 hours (configurable via intervalHours parameter).
 */

import type { Pool } from 'pg';
import { reconcileFromScan } from './storage-counter.js';
import { kvRedisFor } from './redis-registry.js';
import { wrap } from './redis-client.js';

/**
 * Start the daily KV storage-counter reconciliation worker.
 *
 * @param controlDb  — control-plane Postgres pool (reads app_kv_credentials)
 * @param intervalHours — reconciliation interval in hours (default 24)
 * @returns NodeJS.Timeout — store and clearInterval on shutdown
 */
/**
 * One reconcile pass. Exposed so tests can drive it directly without timers.
 */
export async function runReconcileTick(controlDb: Pool): Promise<void> {
    let rows: { app_id: string; region: string; redis_password: string }[];
    try {
      const result = await controlDb.query<{
        app_id: string;
        region: string;
        redis_password: string;
      }>('SELECT app_id, region, redis_password FROM app_kv_credentials');
      rows = result.rows;
    } catch (e) {
      console.error('kv-reconcile: failed to query app_kv_credentials', e);
      return;
    }

    for (const { app_id, region, redis_password } of rows) {
      try {
        // Use the shared pooled ioredis instance for meta-key reads/writes
        // (DB 0). reconcileFromScan also needs baseOpts to scan DB 0 and DB 1
        // independently via short-lived connections.
        const client = wrap(kvRedisFor(region));

        // Build baseOpts from KV_REDIS_URL_<REGION> so reconcileFromScan can
        // open per-DB connections. Falls back to the redis_password stored in
        // app_kv_credentials for per-app auth if needed, but the URL password
        // is the server-level password used by the pooled client.
        const envKey = `KV_REDIS_URL_${region.toUpperCase().replace(/-/g, '_')}`;
        const url = process.env[envKey];
        if (!url) {
          console.warn(`kv-reconcile: missing env var ${envKey} for region ${region}, skipping ${app_id}`);
          continue;
        }
        const u = new URL(url);
        const baseOpts = {
          host: u.hostname,
          port: Number(u.port) || 6379,
          password: u.password || redis_password,
        };

        const { actual, previous } = await reconcileFromScan(client, app_id, baseOpts);
        const drift = actual > 0 ? Math.abs(actual - previous) / actual : 0;
        if (drift > 0.05) {
          console.warn(
            `kv-reconcile drift > 5% for ${app_id}: was=${previous} actual=${actual}`,
          );
        }
      } catch (e) {
        console.error(`kv-reconcile failed for ${app_id}`, e);
      }
    }
}

export function startKvReconcileWorker(
  controlDb: Pool,
  intervalHours = 24,
): NodeJS.Timeout {
  const intervalMs = intervalHours * 3600 * 1000;
  // Defer the first tick — don't run immediately on boot to avoid a load spike
  // while the server is still warming up.
  return setInterval(() => { void runReconcileTick(controlDb); }, intervalMs);
}
