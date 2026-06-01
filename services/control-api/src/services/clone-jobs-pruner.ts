import type pg from 'pg';

const PRUNE_OLDER_THAN_DAYS = 30;
const BATCH_LIMIT = 500;
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface PrunerLogger {
  info(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export async function runOnce(
  controlDb: Pick<pg.Pool, 'query'>,
  logger: PrunerLogger,
): Promise<number> {
  const result = await controlDb.query(
    `DELETE FROM template_clone_jobs
      WHERE id IN (
        SELECT id FROM template_clone_jobs
         WHERE status IN ('completed', 'failed')
           AND created_at < now() - interval '${PRUNE_OLDER_THAN_DAYS} days'
         ORDER BY created_at
         LIMIT $1
      )`,
    [BATCH_LIMIT],
  );
  const deleted = result.rowCount ?? 0;
  if (deleted > 0) {
    logger.info({ deleted }, '[clone-jobs-pruner] pruned stale rows');
  }
  return deleted;
}

export function startCloneJobsPruner(
  controlDb: Pick<pg.Pool, 'query'>,
  logger: PrunerLogger,
  intervalMs: number = DEFAULT_INTERVAL_MS,
): { stop(): Promise<void> } {
  let running = true;
  let currentTimer: ReturnType<typeof setTimeout> | null = null;
  let activeRun: Promise<void> | null = null;

  async function tick(): Promise<void> {
    if (!running) return;
    try {
      await runOnce(controlDb, logger);
    } catch (err) {
      logger.error({ err }, '[clone-jobs-pruner] tick failed');
    } finally {
      if (running) {
        currentTimer = setTimeout(() => {
          activeRun = tick();
        }, intervalMs);
      }
    }
  }

  logger.info({ intervalMs }, '[clone-jobs-pruner] started');
  activeRun = tick();

  return {
    async stop() {
      running = false;
      if (currentTimer !== null) clearTimeout(currentTimer);
      if (activeRun) await activeRun.catch(() => {});
      logger.info({}, '[clone-jobs-pruner] stopped');
    },
  };
}
