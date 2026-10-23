import type { Pool } from 'pg';
import { config } from '../config.js';
import { resolveAppHomeRegion } from './region-resolver.js';
import { redisFor } from './redis-registry.js';
import { getRuntimeDbPool } from './runtime-db.js';
import type { Redis } from 'ioredis';

/** Real request traffic only; cron workers must never call this service. */
export async function markAppActive(
  controlDb: Pool,
  appId: string,
  log: { warn(obj: unknown, msg?: string): void },
): Promise<void> {
  try {
    const region = await resolveAppHomeRegion(controlDb, appId);
    let redis: Redis | undefined;
    let acquired = false;
    const key = `app:active:${appId}`;
    try {
      redis = redisFor(region);
      if (await redis.set(key, '1', 'EX', 3600, 'NX') !== 'OK') return;
      acquired = true;
    } catch (err) {
      // The sweeper's global Redis may be healthy while this regional Redis
      // is down. Losing returning traffic here could wrongly pause a live app.
      log.warn({ err, appId, region }, '[app-activity] throttle unavailable; recording directly');
    }
    try {
      await getRuntimeDbPool(config.runtimeDb, region).query(
        `UPDATE apps SET last_active_at = now(), idle_warned_at = NULL,
                         idle_pause_notified_at = NULL
          WHERE id = $1 AND paused = false
            AND (last_active_at IS NULL OR last_active_at < now() - interval '1 hour'
                 OR idle_warned_at IS NOT NULL OR idle_pause_notified_at IS NOT NULL)`,
        [appId],
      );
    } catch (err) {
      // A failed write is not activity. Allow the next real request to retry.
      if (acquired) await redis!.del(key).catch(() => {});
      throw err;
    }
  } catch (err) {
    log.warn({ err, appId }, '[app-activity] could not record activity');
  }
}
