import type { StepHandler } from './saga-executor.js';
import { invalidateAppRegion } from '../region-resolver.js';
import { setKvBlock } from '../kv/migration-sentinel.js';
import { kvRedisFor } from '../kv/redis-registry.js';
import { wrap } from '../kv/redis-client.js';

export const executeBlockWrites: StepHandler = async (ctx, m) => {
  const sourcePool = ctx.runtimePoolFor(m.source_region);
  await sourcePool.query(
    `UPDATE apps SET provisioning_status = 'migrating', updated_at = now()
     WHERE id = $1 AND provisioning_status IN ('ready','migrating')`,
    [m.app_id],
  );
  try { await invalidateAppRegion(ctx.redisFor(m.source_region), m.app_id); } catch {}
  const sourceKvR = wrap(kvRedisFor(m.source_region));
  await setKvBlock(sourceKvR, m.app_id);
  return { next: 'dumping_data', patch: {} };
};
