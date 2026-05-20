import type { StepHandler } from './saga-executor.js';

export interface ReverseReplicationCtx {
  configureNeonReplication?: (args: { sourceRegion: string; destRegion: string; appId: string; migrationId: string }) => Promise<{ slotName: string }>;
}

const MAX_TRIES = 3;

/**
 * Errors that no number of retries can fix — Neon project needs operator
 * intervention. Skip immediately so the saga doesn't burn retries before
 * marking the migration failed (which would leave the app in a half-moved
 * zombie state, since this step runs after flipping_routing).
 */
const UNRECOVERABLE_PATTERNS = [
  /wal_level/i,
  /logical decoding/i,
  /must be replication role/i,
];

export const executeReverseReplication: StepHandler = async (ctx, m) => {
  const cx = ctx as unknown as ReverseReplicationCtx & typeof ctx;
  if (m.dest_resources.replication_slot) {
    return { next: 'unblocking_writes', patch: {}, sourceReplicaState: 'replicating' };
  }
  if (!cx.configureNeonReplication) {
    ctx.log.warn({ migrationId: m.id }, 'configureNeonReplication not injected; skipping (source_replica_state=none)');
    return { next: 'unblocking_writes', patch: { reverse_replication_skipped: 'not_injected' }, sourceReplicaState: 'none' };
  }
  try {
    const out = await cx.configureNeonReplication({
      sourceRegion: m.source_region, destRegion: m.dest_region, appId: m.app_id, migrationId: m.id,
    });
    return { next: 'unblocking_writes', patch: { replication_slot: out.slotName }, sourceReplicaState: 'replicating' };
  } catch (e) {
    const msg = (e as Error).message;

    // Config-level failures (Neon wal_level, replication role) don't retry-
    // recover — skip immediately to unblocking_writes with no replica.
    if (UNRECOVERABLE_PATTERNS.some((re) => re.test(msg))) {
      ctx.log.warn(
        { migrationId: m.id, err: msg },
        'reverse replication unrecoverable (Neon config); skipping with source_replica_state=none',
      );
      return {
        next: 'unblocking_writes',
        patch: { reverse_replication_skipped: 'unrecoverable', reverse_replication_error: msg },
        sourceReplicaState: 'none',
      };
    }

    // Use saga retry_count instead of our own counter — m.retry_count is
    // persisted by saga-executor on every throw, whereas our previous
    // dest_resources.replication_attempts patch only persisted on
    // success branches (chicken-and-egg, never tripped).
    const nextAttempt = m.retry_count + 1;
    if (nextAttempt >= MAX_TRIES) {
      ctx.log.warn(
        { migrationId: m.id, err: msg, attempts: nextAttempt },
        'reverse replication failed after retries; proceeding with source_replica_state=none',
      );
      return {
        next: 'unblocking_writes',
        patch: { reverse_replication_skipped: 'gave_up', replication_attempts: nextAttempt },
        sourceReplicaState: 'none',
      };
    }
    throw e;
  }
};
