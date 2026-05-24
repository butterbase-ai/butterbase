import type { StepHandler } from './saga-executor.js';
import { clearKvBlock } from '../kv/migration-sentinel.js';
import { kvRedisFor } from '../kv/redis-registry.js';
import { wrap } from '../kv/redis-client.js';

export const executeUnblockWrites: StepHandler = async (ctx, m) => {
  const sourcePool = ctx.runtimePoolFor(m.source_region);
  await sourcePool.query(
    `UPDATE apps SET provisioning_status = 'ready' WHERE id = $1 AND provisioning_status = 'migrating'`,
    [m.app_id],
  );

  // Clear the KV migration sentinel so source-region KV writes resume immediately
  // (rather than wait for the 1h auto-expire). Best-effort — a stale sentinel
  // will self-clear via TTL if Redis is briefly unreachable here.
  try {
    await clearKvBlock(wrap(kvRedisFor(m.source_region)), m.app_id);
  } catch (err) {
    ctx.log.warn(
      { migrationId: m.id, err: (err as Error).message },
      '[move-app unblock] failed to clear KV migration sentinel (will auto-expire)',
    );
  }

  return { next: 'completed', patch: {} };
};
