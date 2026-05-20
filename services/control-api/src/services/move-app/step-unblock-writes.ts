import type { StepHandler } from './saga-executor.js';

export const executeUnblockWrites: StepHandler = async (ctx, m) => {
  const sourcePool = ctx.runtimePoolFor(m.source_region);
  await sourcePool.query(
    `UPDATE apps SET provisioning_status = 'ready' WHERE id = $1 AND provisioning_status = 'migrating'`,
    [m.app_id],
  );
  return { next: 'completed', patch: {} };
};
