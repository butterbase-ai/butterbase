// services/control-api/src/services/failure-notifier.ts
//
// Background scanner that reads function_invocations every 5 minutes,
// detects functions whose failure count today crossed a threshold (1, 10,
// 100, 1000), and emails the app owner — at most once per (function, day,
// threshold). Covers both HTTP and cron failures uniformly because cron
// failures now also write to function_invocations (see cron-scheduler).
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
  FUNCTION_FAILURE_THRESHOLDS,
  type FunctionFailureThreshold,
} from './failure-notifications.service.js';

const SCAN_INTERVAL_MS = 5 * 60 * 1000;
const NOTIF_TTL_SECONDS = 35 * 24 * 60 * 60; // mirrors quota notif TTL

interface FailureGroup {
  app_id: string;
  function_id: string;
  function_name: string;
  today_count: number;
  latest_error: string;
}

async function scanOnce(
  controlPool: Pool,
  log: { info: (p: any, m: string) => void; warn: (p: any, m: string) => void; error: (p: any, m: string) => void },
): Promise<void> {
  // function_invocations + app_functions are per-region runtime tables.
  // Scan every region so failures in any region get noticed.
  const utcDate = new Date().toISOString().slice(0, 10);
  const redis = getRedisClient();

  for (const region of Object.keys(config.runtimeDb.urlsByRegion)) {
    const runtimePool = getRuntimeDbPool(config.runtimeDb, region);

    let groups: FailureGroup[];
    try {
      const r = await runtimePool.query<FailureGroup>(
        `SELECT fi.app_id,
                fi.function_id,
                af.name AS function_name,
                COUNT(*)::int AS today_count,
                (SELECT error_message FROM function_invocations
                  WHERE function_id = fi.function_id
                    AND error_message IS NOT NULL
                    AND started_at >= date_trunc('day', now() AT TIME ZONE 'UTC')
                  ORDER BY started_at DESC LIMIT 1) AS latest_error
           FROM function_invocations fi
           JOIN app_functions af ON af.id = fi.function_id
          WHERE fi.error_message IS NOT NULL
            AND fi.started_at >= date_trunc('day', now() AT TIME ZONE 'UTC')
          GROUP BY fi.app_id, fi.function_id, af.name
         HAVING COUNT(*) >= 1`,
      );
      groups = r.rows;
    } catch (err) {
      log.error({ err, region }, 'failure-notifier: scan query failed');
      continue;
    }

    if (groups.length === 0) continue;

    for (const g of groups) {
      for (const tier of FUNCTION_FAILURE_THRESHOLDS) {
        if (g.today_count < tier) continue;
        const key = `failure_notif:func:${g.app_id}:${g.function_id}:${utcDate}:t${tier}`;
        let wasSet: 'OK' | null = null;
        try {
          wasSet = await redis.set(key, '1', 'EX', NOTIF_TTL_SECONDS, 'NX');
        } catch (err) {
          log.warn({ err, key }, 'failure-notifier: redis SET NX failed');
          continue;
        }
        if (!wasSet) continue; // tier already emailed

        await notifyFunctionFailed(
          controlPool,
          runtimePool,
          {
            appId: g.app_id,
            functionId: g.function_id,
            functionName: g.function_name,
            errorMessage: g.latest_error ?? '(no message)',
            errorCount: g.today_count,
            thresholdTier: tier as FunctionFailureThreshold,
          },
          log,
        ).catch((err) => log.warn({ err, appId: g.app_id, functionId: g.function_id, tier }, 'failure-notifier: notify failed'));
      }
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
