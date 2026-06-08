// services/control-api/src/services/failure-notifier.ts
//
// Background scanner that reads function_invocations every 5 minutes,
// detects functions that have failed FUNCTION_FAILURE_STREAK_THRESHOLD or
// more times consecutively (no successful invocation in between), and
// emails the app owner — at most once per streak. The dedup key is keyed
// on the last-success timestamp so it rotates automatically after a
// successful run, naturally re-arming for the next streak. Covers both
// HTTP and cron failures uniformly because cron failures also write to
// function_invocations (see cron-scheduler).
//
// Phase 2 multi-region: function_invocations, app_functions, and apps are
// runtime-tier tables. The scan query and notifyFunctionFailed calls now use
// a runtimePool derived from the region config.

import type { Pool } from 'pg';
import { getRedisClient } from './redis.js';
import { config, assertRegionConfig } from '../config.js';
import { getRuntimeDbPool } from './runtime-db.js';
import {
  notifyFunctionFailed,
  FUNCTION_FAILURE_STREAK_THRESHOLD,
} from './failure-notifications.service.js';

const SCAN_INTERVAL_MS = 5 * 60 * 1000;
const NOTIF_TTL_SECONDS = 35 * 24 * 60 * 60; // mirrors quota notif TTL
const STREAK_LOOKBACK = '7 days'; // bound the per-region scan

interface FailureGroup {
  app_id: string;
  function_id: string;
  function_name: string;
  streak_len: number;
  latest_error: string;
  streak_key: string;
}

async function scanOnce(
  controlPool: Pool,
  log: { info: (p: any, m: string) => void; warn: (p: any, m: string) => void; error: (p: any, m: string) => void },
): Promise<void> {
  // function_invocations + app_functions are per-region runtime tables.
  // Scan every region so failures in any region get noticed.
  const redis = getRedisClient();

  for (const region of Object.keys(config.runtimeDb.urlsByRegion)) {
    const runtimePool = getRuntimeDbPool(config.runtimeDb, region);

    let groups: FailureGroup[];
    try {
      // For each function, count failures that happened AFTER its most
      // recent successful invocation (or all failures in the lookback
      // window if no success exists yet). The streak_key is the
      // last-success timestamp (or 'none'); the dedup key is keyed on it
      // so the next streak after a successful run gets a fresh key.
      const r = await runtimePool.query<FailureGroup>(
        `WITH last_success AS (
           SELECT function_id, MAX(started_at) AS last_success_at
             FROM function_invocations
            WHERE error_message IS NULL
              AND started_at >= now() - interval '${STREAK_LOOKBACK}'
            GROUP BY function_id
         )
         SELECT fi.app_id,
                fi.function_id,
                af.name AS function_name,
                COUNT(*)::int AS streak_len,
                (array_agg(fi.error_message ORDER BY fi.started_at DESC))[1] AS latest_error,
                COALESCE(ls.last_success_at::text, 'none') AS streak_key
           FROM function_invocations fi
           JOIN app_functions af ON af.id = fi.function_id
           LEFT JOIN last_success ls ON ls.function_id = fi.function_id
          WHERE fi.error_message IS NOT NULL
            AND fi.started_at >= now() - interval '${STREAK_LOOKBACK}'
            AND (ls.last_success_at IS NULL OR fi.started_at > ls.last_success_at)
          GROUP BY fi.app_id, fi.function_id, af.name, ls.last_success_at
         HAVING COUNT(*) >= ${FUNCTION_FAILURE_STREAK_THRESHOLD}`,
      );
      groups = r.rows;
    } catch (err) {
      log.error({ err, region }, 'failure-notifier: scan query failed');
      continue;
    }

    if (groups.length === 0) continue;

    for (const g of groups) {
      const key = `failure_notif:func_streak:${g.function_id}:${g.streak_key}`;
      let wasSet: 'OK' | null = null;
      try {
        wasSet = await redis.set(key, '1', 'EX', NOTIF_TTL_SECONDS, 'NX');
      } catch (err) {
        log.warn({ err, key }, 'failure-notifier: redis SET NX failed');
        continue;
      }
      if (!wasSet) continue; // already emailed for this streak

      await notifyFunctionFailed(
        controlPool,
        runtimePool,
        {
          appId: g.app_id,
          functionId: g.function_id,
          functionName: g.function_name,
          errorMessage: g.latest_error ?? '(no message)',
          streakLen: g.streak_len,
        },
        log,
      ).catch((err) => log.warn({ err, appId: g.app_id, functionId: g.function_id, streakLen: g.streak_len }, 'failure-notifier: notify failed'));
    }
  }
}

/**
 * Start the failure-notifier scan loop. Returns the interval handle so
 * the caller can clear it on shutdown.
 */
export function startFailureNotifier(
  controlPool: Pool,
  log: { info: (p: any, m: string) => void; warn: (p: any, m: string) => void; error: (p: any, m: string) => void },
): NodeJS.Timeout {
  log.info({ intervalMs: SCAN_INTERVAL_MS }, 'failure-notifier started');
  // Don't run immediately — give the rest of the app a beat to come up.
  return setInterval(() => {
    scanOnce(controlPool, log).catch((err) => log.error({ err }, 'failure-notifier: scan threw'));
  }, SCAN_INTERVAL_MS);
}
