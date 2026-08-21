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
  // 0) Read the dest `app_db_connections` row BEFORE step 1 deletes it. Its
  //    `neon_project_id` is the discriminator between the two teardown shapes
  //    (same one `executeDeprovision` uses): equal to the region's shared data
  //    project means the legacy `cust_*` database lives inside it; anything
  //    else means provisionAppDb took the project-per-tenant path and created
  //    a dedicated project that must be deleted whole, or it bills forever and
  //    a retry adopts a project that already has the schema.
  let destConn: { neon_project_id: string; neon_database_name: string } | null = null;
  if (m.dest_resources.dest_app_id) {
    try {
      const destPool = ctx.runtimePoolFor(m.dest_region);
      const r = await destPool.query<{ neon_project_id: string; neon_database_name: string }>(
        `SELECT neon_project_id, neon_database_name FROM app_db_connections WHERE app_id = $1`,
        [m.app_id],
      );
      destConn = r.rows?.[0] ?? null;
    } catch (err) {
      ctx.log.warn(
        { migrationId: m.id, err: (err as Error).message },
        '[move-app abort] dest app_db_connections lookup failed; falling back to shared-project teardown',
      );
    }
  }

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
  //     Under project-per-tenant the dest is a whole project, not a database
  //     inside the shared one, so the tenant branch deletes the project.
  const tenantProjectId =
    destConn?.neon_project_id &&
    destConn.neon_project_id !== getDataProjectIdForRegion(m.dest_region)
      ? destConn.neon_project_id
      : null;

  if (tenantProjectId) {
    try {
      await neonClient.withNeonProjectLock(tenantProjectId, async () => {
        await neonClient.deleteProject(tenantProjectId);
      });
    } catch (err) {
      // Idempotency: an already-deleted project (404) is success, not an error.
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('404') || msg.includes('not found')) {
        ctx.log.info(
          { migrationId: m.id, neonProjectId: tenantProjectId },
          '[move-app abort] dest Neon project already deleted, continuing',
        );
      } else {
        ctx.log.warn(
          { migrationId: m.id, neonProjectId: tenantProjectId, err: msg },
          '[move-app abort] dest Neon project delete failed; continuing (manual cleanup may be needed)',
        );
      }
    }
  } else {
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
