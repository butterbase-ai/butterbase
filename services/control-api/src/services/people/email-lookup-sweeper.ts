/**
 * Stuck-pending `people_email_lookups` sweeper.
 *
 * Async email lookups are inserted as `pending` and moved to `resolved`/`failed`
 * by the provider callback in `routes/people-webhook.ts`. When the provider never
 * calls back — as happened platform-wide between 2026-07-16 and 2026-08-05 — the
 * row stays `pending` forever. Nothing in the codebase ever wrote the `expired`
 * status the table's CHECK constraint already allows, so the only prior cleanup
 * was done by hand, and stuck lookups were invisible in the billing ledger.
 *
 * This sweeper runs hourly, fans out across every configured runtime region, and
 * moves lookups older than PENDING_TTL_HOURS to `expired`.
 *
 * Design notes:
 * - Uses `idx_people_email_pending`, the partial index created by migration 031
 *   for exactly this job and unused until now.
 * - Postgres has no `UPDATE … LIMIT n`, so we use the
 *   `WHERE id IN (SELECT id … LIMIT n)` pattern the other sweepers use.
 * - The expiry and its audit row are one CTE statement, so a lookup can never be
 *   expired without the matching ledger entry.
 * - **No refund.** The audit row records the expiry at zero credits/cost/charged;
 *   the 3 credits taken at queue time are not credited back. Deliberate product
 *   decision — the provider bills us at queue time regardless.
 * - A 42P01 error (relation does not exist) is swallowed so regions whose runtime
 *   DBs have not yet run migration 031 do not spam the error log.
 * - `sweepOnce` is exported separately for clean unit testability.
 */

import { getRuntimeDbPool } from '../runtime-db.js';
import type { RuntimeDbConfig } from '../runtime-db.js';

/** A pending lookup older than this is considered abandoned by the provider. */
export const PENDING_TTL_HOURS = 24;

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
 * Expire one batch of stuck pending lookups in every configured runtime region,
 * writing a zero-cost `profile_email_expired` audit row for each.
 *
 * Returns the total number of lookups expired across all regions.
 */
export async function sweepOnce(
  runtimeDbConfig: RuntimeDbConfig,
  logger: SweeperLogger,
): Promise<{ expired: number }> {
  const regions = Object.keys(runtimeDbConfig.urlsByRegion);
  let total = 0;

  for (const region of regions) {
    const pool = getRuntimeDbPool(runtimeDbConfig, region);
    try {
      const res = await pool.query<never>(
        `WITH swept AS (
           UPDATE people_email_lookups
              SET status = 'expired'
            WHERE id IN (
              SELECT id
                FROM people_email_lookups
               WHERE status = 'pending'
                 AND requested_at < now() - ($1::int * interval '1 hour')
               ORDER BY requested_at
               LIMIT $2
            )
           RETURNING app_id, organization_id, user_id, normalized_url,
                     provider_slot, key_type
         )
         INSERT INTO people_usage_logs
           (app_id, organization_id, user_id, action, credits_consumed,
            usd_cost, usd_charged, key_type, request_id, response_status,
            linkedin_url, provider_slot)
         SELECT app_id, organization_id, user_id, 'profile_email_expired', 0,
                0, 0, key_type, NULL, NULL,
                normalized_url, provider_slot
           FROM swept`,
        [PENDING_TTL_HOURS, BATCH_SIZE],
      );
      const expired = res.rowCount ?? 0;
      if (expired > 0) {
        logger.info({ region, expired }, '[people-email-sweeper] expired stuck pending lookups');
      }
      total += expired;
    } catch (err: any) {
      // 42P01 = relation does not exist — runtime DB has not yet run migration
      // 031. Skip silently; once the migration lands the sweeper will pick up.
      if (err?.code === '42P01') continue;
      logger.error({ err, region }, '[people-email-sweeper] sweep failed for region');
    }
  }

  return { expired: total };
}

/**
 * Start the recurring stuck-pending email-lookup sweeper.
 *
 * @param runtimeDbConfig  RuntimeDbConfig with per-region connection URLs.
 * @param logger           Any logger with info/warn/error methods.
 * @param intervalMs       Sweep interval in milliseconds (default 1 hour).
 * @returns                A handle with a stop() method for graceful shutdown.
 */
export function startEmailLookupSweeper(
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
      logger.error({ err }, '[people-email-sweeper] tick failed');
    } finally {
      if (running) {
        currentTimer = setTimeout(() => {
          activeRun = tick();
        }, intervalMs);
      }
    }
  }

  logger.info(
    { intervalMs, ttlHours: PENDING_TTL_HOURS, regions: Object.keys(runtimeDbConfig.urlsByRegion) },
    '[people-email-sweeper] started',
  );
  activeRun = tick();

  return {
    async stop(): Promise<void> {
      running = false;
      if (currentTimer !== null) clearTimeout(currentTimer);
      if (activeRun) await activeRun.catch(() => {});
      logger.info({}, '[people-email-sweeper] stopped');
    },
  };
}
