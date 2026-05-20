import type pg from 'pg';
import type { Pool } from 'pg';
import { createMigration, type MigrationRow } from './migration-store.js';
import { MOVE_APP_RUNTIME_TABLES } from './runtime-tables.js';

export interface SlowPathCtx {
  controlPool: pg.Pool;
  runtimePoolFor: (region: string) => Pool;
}

export interface SlowPathArgs {
  forward: MigrationRow;
  userId: string;
}

/**
 * Slow-path reverse-move: replays the saga in reverse using a fresh dump.
 * Used when the source customer DB is no longer a live replica
 * (source_replica_state in {'none', 'torn_down', or stale}).
 *
 * Pre-clears the original-source's archived_after_move tags so the saga's
 * copying_runtime step (running in the reverse direction) can re-write
 * the rows without losing post-cutover writes from the live primary.
 */
export async function runReverseMoveSlowPath(
  ctx: SlowPathCtx, args: SlowPathArgs,
): Promise<{ migrationId: string }> {
  // 1. Clear archived_after_move tags on the original source's runtime tables.
  //    These tags were written during the FORWARD move's copying_runtime step.
  //    Clearing them lets the reverse saga's copying_runtime overwrite stale
  //    rows on this side without ON CONFLICT silently keeping the archived ones.
  const originalSource = ctx.runtimePoolFor(args.forward.source_region);
  for (const table of MOVE_APP_RUNTIME_TABLES) {
    await originalSource.query(
      `UPDATE "${table}" SET archived_after_move = NULL WHERE archived_after_move = $1`,
      [args.forward.id],
    ).catch((e: any) => {
      // Table may not exist on this region's runtime DB — skip silently.
      if (!String(e.message).includes('does not exist')) throw e;
    });
  }

  // 2. Create a new app_migrations row with swapped regions.
  const revId = await createMigration(ctx.controlPool, {
    appId: args.forward.app_id,
    userId: args.userId,
    sourceRegion: args.forward.dest_region,   // current primary
    destRegion: args.forward.source_region,   // former primary, target
  });

  return { migrationId: revId };
}
