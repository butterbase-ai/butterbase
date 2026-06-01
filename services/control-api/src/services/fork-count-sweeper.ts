/**
 * Cross-region fork_count decrement sweeper.
 *
 * When a cloned app is deleted and its template source lives in a different
 * region, the runtime-plane DELETE trigger cannot decrement the remote
 * fork_count (triggers are local to their region's DB).  The delete handler
 * instead inserts a row into the control-plane `fork_count_decrements` table.
 * This sweeper runs every 30 s, processes unprocessed rows in batches, debits
 * source.fork_count via the per-region runtime pool, and marks rows processed.
 *
 * Design notes:
 * - GREATEST(0, fork_count - 1) prevents underflow if the source was already
 *   at 0 (e.g. multiple concurrent deletes or manual reset).
 * - A row that fails (region unreachable, app already deleted) is logged and
 *   retried next tick.  There is no dead-letter queue: the worst outcome is a
 *   slightly inflated fork_count, which is eventually consistent anyway.
 * - `runOnce` is exported separately for clean unit testability.
 */

import pg from 'pg';
import { getRuntimeDbPool } from './runtime-db.js';
import type { RuntimeDbConfig } from './runtime-db.js';

const SWEEP_INTERVAL_MS = 30_000;
const BATCH_SIZE = 100;

export interface SweeperLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface SweeperHandle {
  stop: () => Promise<void>;
}

interface DecrementRow {
  id: string;
  source_app_id: string;
  source_region: string;
}

/**
 * Process one sweep of unprocessed fork_count_decrements rows.
 * Exported so unit tests can call it directly without timer management.
 */
export async function runOnce(
  controlDb: pg.Pool,
  runtimeDbConfig: RuntimeDbConfig,
  logger: SweeperLogger,
): Promise<void> {
  const batch = await controlDb.query<DecrementRow>(
    `SELECT id, source_app_id, source_region
       FROM fork_count_decrements
      WHERE processed_at IS NULL
      ORDER BY created_at
      LIMIT $1`,
    [BATCH_SIZE],
  );

  if (batch.rows.length === 0) return;

  for (const row of batch.rows) {
    try {
      const pool = getRuntimeDbPool(runtimeDbConfig, row.source_region);
      await pool.query(
        `UPDATE apps SET fork_count = GREATEST(0, fork_count - 1) WHERE id = $1`,
        [row.source_app_id],
      );
      await controlDb.query(
        `UPDATE fork_count_decrements SET processed_at = now() WHERE id = $1`,
        [row.id],
      );
    } catch (err) {
      logger.error(
        { err, decrementId: row.id, sourceAppId: row.source_app_id, sourceRegion: row.source_region },
        '[fork-sweeper] decrement failed; will retry next tick',
      );
    }
  }
}

/**
 * Start the recurring fork_count decrement sweeper.
 *
 * @param controlDb       Pool for the control-plane DB (fork_count_decrements table).
 * @param runtimeDbConfig RuntimeDbConfig with per-region connection URLs.
 * @param logger          Any logger with info/warn/error methods.
 * @param intervalMs      Sweep interval in milliseconds (default 30 000).
 * @returns               A handle with a stop() method to await graceful shutdown.
 */
export function startForkCountSweeper(
  controlDb: pg.Pool,
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
      await runOnce(controlDb, runtimeDbConfig, logger);
    } catch (err) {
      logger.error({ err }, '[fork-sweeper] tick failed');
    } finally {
      if (running) {
        currentTimer = setTimeout(() => {
          activeRun = tick();
        }, intervalMs);
      }
    }
  }

  logger.info({ intervalMs }, '[fork-sweeper] started');
  activeRun = tick();

  return {
    async stop(): Promise<void> {
      running = false;
      if (currentTimer !== null) clearTimeout(currentTimer);
      if (activeRun) await activeRun.catch(() => {});
      logger.info({}, '[fork-sweeper] stopped');
    },
  };
}
