import type pg from 'pg';
import { getMigration, createMigration, markCompleted } from './migration-store.js';
import { runReverseMoveSlowPath } from './reverse-move-slow-path.js';
import { dumpKvFromRegion as defaultDumpKvFromRegion } from './step-dump-kv.js';
import { restoreKvIntoRegion as defaultRestoreKvIntoRegion } from './step-restore-kv.js';
import { clearKvScope as defaultClearKvScope } from '../kv/kv-scope.js';

export interface ReverseMoveCtx {
  controlPool: pg.Pool;
  runtimePoolFor: (region: string) => pg.Pool;
  writeSubdomainMapping: (subdomain: string, appId: string, region: string) => Promise<void>;
  writeDomainMapping: (hostname: string, appId: string, region: string) => Promise<void>;
  listCustomDomains: (region: string, appId: string) => Promise<Array<{ hostname: string }>>;
  invalidateCacheAllRegions: (appId: string) => Promise<void>;
  updateUserAppIndexRegion: (controlPool: pg.Pool, appId: string, region: string) => Promise<void>;
  waitForReplicationCaughtUp: (region: string, appId: string, migrationId: string) => Promise<void>;
  promoteSourceToPrimary: (region: string, appId: string, migrationId: string) => Promise<void>;
  /** Optional log surface — fast path emits info on success and error on failure. */
  log?: { info?: (obj: any, msg: string) => void; warn?: (obj: any, msg: string) => void; error?: (obj: any, msg: string) => void };
  /** Test seam — defaults to the saga's dumpKvFromRegion. */
  dumpKvFromRegion?: typeof defaultDumpKvFromRegion;
  /** Test seam — defaults to the kv-scope helper. */
  clearKvScope?: typeof defaultClearKvScope;
  /** Test seam — defaults to the saga's restoreKvIntoRegion. */
  restoreKvIntoRegion?: typeof defaultRestoreKvIntoRegion;
}

export async function runReverseMove(
  ctx: ReverseMoveCtx,
  args: { forwardMigrationId: string; userId: string },
): Promise<{ migrationId: string; path: 'fast' | 'slow' }> {
  const forward = await getMigration(ctx.controlPool, args.forwardMigrationId);
  if (!forward) throw new Error(`forward migration ${args.forwardMigrationId} not found`);
  if (forward.current_step !== 'completed') {
    throw new Error('reverse-move requires the forward migration to be completed');
  }

  if (forward.source_replica_state !== 'replicating') {
    // Slow path: enqueue a swapped-direction migration and let the saga driver handle it.
    // The saga's HAPPY_PATH_ORDER includes dumping_kv + restoring_kv, so KV is automatically
    // migrated in the reverse direction (dest_region → source_region) by the saga steps.
    // No additional KV handling is needed here. ✅
    const slowCtx = { controlPool: ctx.controlPool, runtimePoolFor: ctx.runtimePoolFor };
    const { migrationId } = await runReverseMoveSlowPath(slowCtx, { forward, userId: args.userId });
    return { migrationId, path: 'slow' as const };
  }

  const revId = await createMigration(ctx.controlPool, {
    appId: forward.app_id, userId: args.userId,
    sourceRegion: forward.dest_region,
    destRegion: forward.source_region,
  });

  await ctx.runtimePoolFor(forward.dest_region).query(
    `UPDATE apps SET provisioning_status = 'migrating' WHERE id = $1`, [forward.app_id],
  );
  await ctx.invalidateCacheAllRegions(forward.app_id);

  await ctx.waitForReplicationCaughtUp(forward.source_region, forward.app_id, forward.id);
  await ctx.promoteSourceToPrimary(forward.source_region, forward.app_id, forward.id);

  // ── KV reverse-migration (closes the Task 8 gap) ──────────────────────
  // Dump from the (current) KV region, clear the original-source's scope
  // so the restore guard passes, then restore + flip routing back.
  // Best-effort (no write block) per spec: any KV writes during this
  // window may land on the about-to-be-stale region.
  const dumpKv = ctx.dumpKvFromRegion ?? defaultDumpKvFromRegion;
  const clearKv = ctx.clearKvScope ?? defaultClearKvScope;
  const restoreKv = ctx.restoreKvIntoRegion ?? defaultRestoreKvIntoRegion;
  try {
    const { key, records: dumped } = await dumpKv({
      sourceRegion: forward.dest_region,
      appId:        forward.app_id,
      migrationId:  `${forward.id}-reverse`,
      log:          { info: ctx.log?.info ?? (() => {}) },
    });
    const cleared = await clearKv(forward.source_region, forward.app_id);
    const { records: restored } = await restoreKv({
      destRegion:            forward.source_region,
      sourceRegionForBucket: forward.dest_region,
      appId:                 forward.app_id,
      key,
      controlPool:           ctx.controlPool,
      flipTo:                forward.source_region,
      log:                   { info: ctx.log?.info ?? (() => {}) },
    });
    ctx.log?.info?.(
      { forwardMigrationId: forward.id, appId: forward.app_id, dumped, restored, cleared },
      '[reverse-move] kv migrated back to source',
    );
  } catch (err) {
    ctx.log?.error?.(
      { forwardMigrationId: forward.id, err: (err as Error).message },
      '[reverse-move] KV reverse-migration failed after PG promotion; manual reconcile required',
    );
    throw err;
  }

  await ctx.updateUserAppIndexRegion(ctx.controlPool, forward.app_id, forward.source_region);
  const subRes = await ctx.runtimePoolFor(forward.source_region).query<{ subdomain: string }>(
    `SELECT subdomain FROM apps WHERE id = $1`, [forward.app_id],
  );
  const sub = subRes.rows[0]?.subdomain;
  if (sub) await ctx.writeSubdomainMapping(sub, forward.app_id, forward.source_region);
  const doms = await ctx.listCustomDomains(forward.source_region, forward.app_id);
  for (const d of doms) {
    await ctx.writeDomainMapping(d.hostname, forward.app_id, forward.source_region);
  }
  await ctx.invalidateCacheAllRegions(forward.app_id);

  const sourcePool = ctx.runtimePoolFor(forward.source_region);
  const tables = [
    'app_users','app_refresh_tokens','app_verification_codes','app_signing_keys',
    'app_oauth_configs','app_custom_domains','app_functions','function_triggers',
    'app_edge_ssr_deployments','app_durable_objects','app_realtime_config',
    'app_integration_configs','storage_objects','app_db_connections',
    'app_orders','app_plans','app_products','app_subscriptions',
  ];
  for (const t of tables) {
    await sourcePool.query(`UPDATE "${t}" SET archived_after_move = NULL WHERE archived_after_move = $1`, [forward.id]);
  }

  await sourcePool.query(
    `UPDATE apps SET provisioning_status = 'ready', region = $1 WHERE id = $2`,
    [forward.source_region, forward.app_id],
  );

  await markCompleted(ctx.controlPool, revId);

  return { migrationId: revId, path: 'fast' as const };
}
