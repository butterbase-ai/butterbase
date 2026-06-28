/**
 * Expired ai_responses row sweeper.
 *
 * The Responses API stores LLM responses in per-app runtime `ai_responses`
 * tables with a Unix-epoch `expires_at` column. Without periodic cleanup those
 * rows accumulate forever. This sweeper runs on an hourly interval, fans out
 * across every configured runtime region, and batch-deletes rows whose TTL has
 * passed.
 *
 * Design notes:
 * - Postgres does not support `DELETE … LIMIT n`; we use the
 *   `DELETE FROM t WHERE id IN (SELECT id FROM t WHERE … LIMIT n)` pattern
 *   that matches other batched deletes in this codebase.
 * - A 42P01 error (relation does not exist) is swallowed so that regions whose
 *   runtime DBs have not yet run migration 029 do not spam the error log.
 * - `sweepOnce` is exported separately for clean unit testability.
 */

import { getRuntimeDbPool } from '../runtime-db.js';
import type { RuntimeDbConfig } from '../runtime-db.js';

const SWEEP_INTERVAL_MS = 60 * 60 * 1000; // hourly
const BATCH_SIZE = 1000;

export interface SweeperLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface SweeperHandle {
  stop: () => Promise<void>;
}

/**
 * Delete one batch of expired rows from every configured runtime region.
 * Returns the total number of rows deleted across all regions.
 */
export async function sweepOnce(
  runtimeDbConfig: RuntimeDbConfig,
  logger: SweeperLogger,
): Promise<{ deleted: number }> {
  const regions = Object.keys(runtimeDbConfig.urlsByRegion);
  let total = 0;

  for (const region of regions) {
    const pool = getRuntimeDbPool(runtimeDbConfig, region);
    try {
      const res = await pool.query<never>(
        `DELETE FROM ai_responses
          WHERE id IN (
            SELECT id FROM ai_responses
             WHERE expires_at < $1
             LIMIT $2
          )`,
        [Math.floor(Date.now() / 1000), BATCH_SIZE],
      );
      const deleted = res.rowCount ?? 0;
      if (deleted > 0) {
        logger.info({ region, deleted }, '[responses-sweeper] deleted expired rows');
      }
      total += deleted;
    } catch (err: any) {
      // 42P01 = relation does not exist — runtime DB has not yet run migration
      // 029. Skip silently; once the migration lands the sweeper will pick up.
      if (err?.code === '42P01') continue;
      logger.error({ err, region }, '[responses-sweeper] sweep failed for region');
    }
  }

  return { deleted: total };
}

/**
 * Start the recurring expired-responses sweeper.
 *
 * @param runtimeDbConfig  RuntimeDbConfig with per-region connection URLs.
 * @param logger           Any logger with info/warn/error methods.
 * @param intervalMs       Sweep interval in milliseconds (default 1 hour).
 * @returns                A handle with a stop() method for graceful shutdown.
 */
export function startResponsesSweeper(
  runtimeDbConfig: RuntimeDbConfig,
  logger: SweeperLogger,
  intervalMs = SWEEP_INTERVAL_MS,
): SweeperHandle {
  let running = true;
  let currentTimer: ReturnType<typeof setTimeout> | null = null;
  let activeRun: Promise<void> | null = null;

  async function tick(): Promise<void> {
    if (!running) return;
    try {
      await sweepOnce(runtimeDbConfig, logger);
    } catch (err) {
      logger.error({ err }, '[responses-sweeper] tick failed');
    } finally {
      if (running) {
        currentTimer = setTimeout(() => {
          activeRun = tick();
        }, intervalMs);
      }
    }
  }

  logger.info({ intervalMs, regions: Object.keys(runtimeDbConfig.urlsByRegion) }, '[responses-sweeper] started');
  activeRun = tick();

  return {
    async stop(): Promise<void> {
      running = false;
      if (currentTimer !== null) clearTimeout(currentTimer);
      if (activeRun) await activeRun.catch(() => {});
      logger.info({}, '[responses-sweeper] stopped');
    },
  };
}
