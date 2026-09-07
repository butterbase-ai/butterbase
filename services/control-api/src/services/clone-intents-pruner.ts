import type pg from 'pg';

const AUDIT_OLDER_THAN_DAYS = 30;
const BATCH_LIMIT = 500;
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface PrunerLogger {
  info(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export async function runOnce(
  controlDb: Pick<pg.Pool, 'query'>,
  logger: PrunerLogger,
): Promise<{ expired: number; audit: number }> {
  const expiredResult = await controlDb.query(
    `DELETE FROM template_clone_intents
      WHERE id IN (
        SELECT id FROM template_clone_intents
         WHERE redeemed_at IS NULL
           AND expires_at < now()
         ORDER BY expires_at
         LIMIT $1
      )`,
    [BATCH_LIMIT],
  );
  const expired = expiredResult.rowCount ?? 0;

  const auditResult = await controlDb.query(
    `DELETE FROM template_clone_intents
      WHERE id IN (
        SELECT id FROM template_clone_intents
         WHERE redeemed_at IS NOT NULL
           AND created_at < now() - interval '${AUDIT_OLDER_THAN_DAYS} days'
         ORDER BY created_at
         LIMIT $1
      )`,
    [BATCH_LIMIT],
  );
  const audit = auditResult.rowCount ?? 0;

  if (expired > 0 || audit > 0) {
    logger.info({ expired, audit }, '[clone-intents-pruner] pruned rows');
  }

  return { expired, audit };
}

export function startCloneIntentsPruner(
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
      logger.error({ err }, '[clone-intents-pruner] tick failed');
    } finally {
      if (running) {
        currentTimer = setTimeout(() => {
          activeRun = tick();
        }, intervalMs);
      }
    }
  }

  logger.info({ intervalMs }, '[clone-intents-pruner] started');
  activeRun = tick();

  return {
    async stop() {
      running = false;
      if (currentTimer !== null) clearTimeout(currentTimer);
      if (activeRun) await activeRun.catch(() => {});
      logger.info({}, '[clone-intents-pruner] stopped');
    },
  };
}
