import type { StepHandler } from './saga-executor.js';
import { invalidateAppRegion } from '../region-resolver.js';
import * as neonClient from '../neon-client.js';
import { getDataProjectIdForRegion } from '../neon-projects.js';
import { clearKvBlock } from '../kv/migration-sentinel.js';
import { kvRedisFor } from '../kv/redis-registry.js';
import { wrap } from '../kv/redis-client.js';

/**
 * Compensation handler. Runs when a saga step exhausts retries and the
 * driver transitions to `aborting`. Undoes the user-visible damage so the
 * source app keeps serving traffic and the dashboard stops showing a
 * stranded "Pending" tile in the destination region:
 *
 *   1. DELETE the dest `apps` row created by `reserving_dest` (it has
 *      `provisioning_status = 'migration_target_reserved'` and a
 *      `db_name` suffixed with `__pending`).
 *   2. If `blocking_writes` flipped the source `provisioning_status` to
 *      `migrating`, flip it back to `ready` so the source resumes
 *      accepting writes.
 *   3. Invalidate the region cache for the app in both regions.
 *
 * Deliberately scoped: does NOT deprovision the dest Neon DB or delete
 * the R2 dump. Those are internal leaks the reaper can sweep later.
 * After flipping_routing the dest is authoritative — aborting would
 * lose data, so the driver should never set 'aborting' that late
 * (saga-executor enforces this).
 */
export const executeAbort: StepHandler = async (ctx, m) => {
  // 1) Remove the dest reservation row, if reserving_dest got far enough
  //    to create it. Idempotent: row may already be gone.
  if (m.dest_resources.dest_app_id) {
    try {
      const destPool = ctx.runtimePoolFor(m.dest_region);
      await destPool.query(
        `DELETE FROM apps WHERE id = $1 AND provisioning_status = 'migration_target_reserved'`,
        [m.app_id],
      );
      // app_db_connections is in the dest region's runtime DB; remove it too
      // so the next attempt re-INSERTs cleanly via provisionAppDb.
      await destPool.query(
        `DELETE FROM app_db_connections WHERE app_id = $1`,
        [m.app_id],
      );
    } catch (err) {
      ctx.log.warn(
        { migrationId: m.id, err: (err as Error).message },
        '[move-app abort] dest apps row cleanup failed; continuing',
      );
    }
  }

  // 1b) Delete the dest Neon DB so the next retry starts with an empty target.
  //     Without this, restoring_data fails on the second attempt with
  //     'schema "realtime" already exists' (or similar) because the prior
  //     attempt's restore left objects behind in the same Neon DB.
  const neonDbName = m.dest_resources.neon_db_name as string | undefined;
  if (neonDbName) {
    const dataProjectId = getDataProjectIdForRegion(m.dest_region);
    if (dataProjectId) {
      try {
        await neonClient.withNeonProjectLock(dataProjectId, async () => {
          await neonClient.deleteDatabase(dataProjectId, neonDbName);
        });
      } catch (err) {
        ctx.log.warn(
          { migrationId: m.id, neonDbName, err: (err as Error).message },
          '[move-app abort] dest Neon DB delete failed; continuing (manual cleanup may be needed)',
        );
      }
    }
  }

  // 2) Restore source provisioning_status if blocking_writes flipped it.
  try {
    const sourcePool = ctx.runtimePoolFor(m.source_region);
    await sourcePool.query(
      `UPDATE apps SET provisioning_status = 'ready', updated_at = now()
       WHERE id = $1 AND provisioning_status = 'migrating'`,
      [m.app_id],
    );
  } catch (err) {
    ctx.log.warn(
      { migrationId: m.id, err: (err as Error).message },
      '[move-app abort] source provisioning_status restore failed; continuing',
    );
  }

  // 3) Bust region caches so anyone holding a stale pool picks up fresh state.
  for (const region of [m.source_region, m.dest_region]) {
    try { await invalidateAppRegion(ctx.redisFor(region), m.app_id); } catch {}
  }

  // 4) Clear KV migration sentinels on both regions (best-effort, idempotent).
  //    Source had it set by block-writes; dest never did but clearing is safe.
  for (const region of [m.source_region, m.dest_region]) {
    try {
      await clearKvBlock(wrap(kvRedisFor(region)), m.app_id);
    } catch (err) {
      ctx.log.warn(
        { migrationId: m.id, region, err: (err as Error).message },
        '[move-app abort] failed to clear KV migration sentinel; continuing',
      );
    }
  }

  return { next: 'aborted', patch: {} };
};
