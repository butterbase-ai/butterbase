// Background pruner for `template_clone_intents`.
//
// Two passes with DIFFERENT urgency, and therefore different cadences:
//
//   * EXPIRED-UNREDEEMED. These rows still hold `encrypted_env_values` — LIVE
//     SECRETS. Nothing NULLs that column at expiry, so this delete is the ONLY
//     mechanism that removes them. The design spec
//     (docs/superpowers/specs/2026-09-07-public-templates-site-design.md)
//     asserts "Maximum plaintext-recoverable window is the 60-minute TTL", so
//     this pass must run on a short interval AND must drain a backlog rather
//     than trickling one batch per tick.
//   * AUDIT (redeemed, older than 30 days). `encrypted_env_values` was already
//     NULLed at redemption, so these rows hold no secrets. Pure housekeeping —
//     a daily single batch is fine.

import type pg from 'pg';

const AUDIT_OLDER_THAN_DAYS = 30;
const BATCH_LIMIT = 500;

// 5 minutes. Chosen as the smallest interval that is still cheap against an
// index-backed delete: at worst it adds 5 minutes to the spec's 60-minute TTL,
// keeping the plaintext-recoverable window ~65 minutes rather than the ~25
// HOURS a daily sweep produced. Anything shorter buys minutes of exposure at
// the cost of a constant query drumbeat on the control DB.
const DEFAULT_EXPIRED_INTERVAL_MS = 5 * 60 * 1000;

// The audit pass touches no secrets; daily is deliberate and unchanged.
const DEFAULT_AUDIT_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Safety bound on the drain loop: 40 full batches = 20,000 rows per tick, far
// above any plausible 5-minute creation rate (the anonymous endpoint is rate
// limited to 10/hour/IP). It exists so that a pathological table — e.g. a
// clock skew or a predicate bug that makes every pass return a full batch —
// cannot spin this tick forever and starve the process; the next tick, 5
// minutes later, simply picks up where it left off.
const MAX_EXPIRED_BATCHES_PER_TICK = 40;

export interface PrunerLogger {
  info(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

/**
 * Delete expired, unredeemed intents — the secret-bearing rows — looping until
 * a pass comes back short of a full batch (nothing left to drain) or the
 * iteration bound is hit.
 */
export async function runExpiredPass(
  controlDb: Pick<pg.Pool, 'query'>,
): Promise<{ expired: number; batches: number; hitLimit: boolean }> {
  let expired = 0;
  let batches = 0;
  let hitLimit = false;

  for (;;) {
    const result = await controlDb.query(
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
    const rows = result.rowCount ?? 0;
    expired += rows;
    batches += 1;

    // A short batch means the expired set is drained.
    if (rows < BATCH_LIMIT) break;
    if (batches >= MAX_EXPIRED_BATCHES_PER_TICK) {
      hitLimit = true;
      break;
    }
  }

  return { expired, batches, hitLimit };
}

/**
 * Delete redeemed intents older than 30 days. These have had
 * `encrypted_env_values` NULLed at redemption; one batch per daily tick is
 * enough and deliberately does not loop.
 */
export async function runAuditPass(
  controlDb: Pick<pg.Pool, 'query'>,
): Promise<{ audit: number }> {
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
  return { audit: auditResult.rowCount ?? 0 };
}

/** Both passes back to back. Retained for callers/tests that want one shot. */
export async function runOnce(
  controlDb: Pick<pg.Pool, 'query'>,
  logger: PrunerLogger,
): Promise<{ expired: number; audit: number }> {
  const { expired, batches, hitLimit } = await runExpiredPass(controlDb);
  const { audit } = await runAuditPass(controlDb);

  if (expired > 0 || audit > 0) {
    logger.info({ expired, audit, batches, hitLimit }, '[clone-intents-pruner] pruned rows');
  }

  return { expired, audit };
}

/**
 * Schedule one pass on its own interval. Each returned handle owns exactly one
 * timer chain, so the two passes can run at different cadences without either
 * one's duration shifting the other's schedule.
 */
function schedulePass(
  name: string,
  intervalMs: number,
  logger: PrunerLogger,
  run: () => Promise<void>,
): { stop(): Promise<void> } {
  let running = true;
  let currentTimer: ReturnType<typeof setTimeout> | null = null;
  let activeRun: Promise<void> | null = null;

  async function tick(): Promise<void> {
    if (!running) return;
    try {
      await run();
    } catch (err) {
      logger.error({ err, pass: name }, '[clone-intents-pruner] tick failed');
    } finally {
      if (running) {
        currentTimer = setTimeout(() => {
          activeRun = tick();
        }, intervalMs);
      }
    }
  }

  activeRun = tick();

  return {
    async stop() {
      running = false;
      if (currentTimer !== null) clearTimeout(currentTimer);
      if (activeRun) await activeRun.catch(() => {});
    },
  };
}

export function startCloneIntentsPruner(
  controlDb: Pick<pg.Pool, 'query'>,
  logger: PrunerLogger,
  opts: { expiredIntervalMs?: number; auditIntervalMs?: number } = {},
): { stop(): Promise<void> } {
  const expiredIntervalMs = opts.expiredIntervalMs ?? DEFAULT_EXPIRED_INTERVAL_MS;
  const auditIntervalMs = opts.auditIntervalMs ?? DEFAULT_AUDIT_INTERVAL_MS;

  const expiredHandle = schedulePass('expired', expiredIntervalMs, logger, async () => {
    const { expired, batches, hitLimit } = await runExpiredPass(controlDb);
    if (expired > 0) {
      logger.info(
        { expired, batches, hitLimit },
        '[clone-intents-pruner] pruned expired unredeemed intents',
      );
    }
    if (hitLimit) {
      logger.error(
        { expired, batches },
        '[clone-intents-pruner] expired pass hit its per-tick batch bound; backlog remains',
      );
    }
  });

  const auditHandle = schedulePass('audit', auditIntervalMs, logger, async () => {
    const { audit } = await runAuditPass(controlDb);
    if (audit > 0) {
      logger.info({ audit }, '[clone-intents-pruner] pruned old redeemed intents');
    }
  });

  logger.info({ expiredIntervalMs, auditIntervalMs }, '[clone-intents-pruner] started');

  return {
    async stop() {
      await Promise.all([expiredHandle.stop(), auditHandle.stop()]);
      logger.info({}, '[clone-intents-pruner] stopped');
    },
  };
}
