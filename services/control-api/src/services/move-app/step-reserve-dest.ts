// services/control-api/src/services/move-app/step-reserve-dest.ts
import type { StepHandler } from './saga-executor.js';

interface ProvisionedDb {
  neonDbName: string;
  connectionUri: string;
}

export interface ReserveDestCtx {
  provisionAppDb?: (region: string, appId: string, ownerId: string) => Promise<ProvisionedDb>;
}

export const executeReserveDest: StepHandler = async (ctx, m) => {
  const cx = ctx as unknown as ReserveDestCtx & typeof ctx;
  const destPool = ctx.runtimePoolFor(m.dest_region);

  if (!m.dest_resources.dest_app_id) {
    const sourcePool = ctx.runtimePoolFor(m.source_region);
    const src = await sourcePool.query<{ name: string; db_name: string; subdomain: string | null }>(
      `SELECT name, db_name, subdomain FROM apps WHERE id = $1`, [m.app_id],
    );
    if (src.rows.length === 0) throw new Error(`source apps row ${m.app_id} not found in ${m.source_region}`);
    const row = src.rows[0];
    await destPool.query(
      `INSERT INTO apps (id, name, owner_id, db_name, subdomain, region, provisioning_status)
       VALUES ($1, $2, $3, $4, $5, $6, 'migration_target_reserved')
       ON CONFLICT (id) DO UPDATE
         SET region = EXCLUDED.region,
             provisioning_status = 'migration_target_reserved'`,
      [m.app_id, row.name, m.user_id, row.db_name + '__pending', row.subdomain, m.dest_region],
    );
  }

  let neonDbName = m.dest_resources.neon_db_name as string | undefined;
  if (!neonDbName) {
    if (!cx.provisionAppDb) throw new Error('provisionAppDb not injected');
    const out = await cx.provisionAppDb(m.dest_region, m.app_id, m.user_id);
    neonDbName = out.neonDbName;
  }

  return {
    next: 'blocking_writes',
    patch: { dest_app_id: m.app_id, neon_db_name: neonDbName },
  };
};
