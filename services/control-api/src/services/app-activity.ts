import type { Pool } from 'pg';
import { config } from '../config.js';
import { resolveAppHomeRegion } from './region-resolver.js';
import { redisFor } from './redis-registry.js';
import { getRuntimeDbPool } from './runtime-db.js';

/** Real request traffic only; cron workers must never call this service. */
export async function markAppActive(
  controlDb: Pool,
  appId: string,
  log: { warn(obj: unknown, msg?: string): void },
): Promise<void> {
  try {
    const region = await resolveAppHomeRegion(controlDb, appId);
    const redis = redisFor(region);
    const key = `app:active:${appId}`;
    if (await redis.set(key, '1', 'EX', 3600, 'NX') !== 'OK') return;
    try {
      await getRuntimeDbPool(config.runtimeDb, region).query(
        `UPDATE apps SET last_active_at = now(), idle_warned_at = NULL,
                         idle_pause_notified_at = NULL
          WHERE id = $1 AND paused = false`,
        [appId],
      );
    } catch (err) {
      // A failed write is not activity. Allow the next real request to retry.
      await redis.del(key).catch(() => {});
      throw err;
    }
  } catch (err) {
    log.warn({ err, appId }, '[app-activity] could not record activity');
  }
}
