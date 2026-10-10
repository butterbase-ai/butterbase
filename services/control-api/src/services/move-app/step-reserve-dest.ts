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

  // Moving an app to the region it already occupies is a no-op, and it is the
  // one case where the source and destination Neon projects would collide on
  // name under region-scoped naming (`bb-<appId>-<region>`) — the source
  // database is retained after cutover, so both would exist at once.
  if (m.dest_region === m.source_region) {
    throw new Error(
      `cannot move app ${m.app_id} to its current region ${m.dest_region}: source and destination regions must differ`,
    );
  }

  const destPool = ctx.runtimePoolFor(m.dest_region);

  if (!m.dest_resources.dest_app_id) {
    const sourcePool = ctx.runtimePoolFor(m.source_region);
    const src = await sourcePool.query<{ row: Record<string, unknown> }>(
      `SELECT row_to_json(a) AS row FROM apps a WHERE id = $1`, [m.app_id],
    );
    if (src.rows.length === 0) throw new Error(`source apps row ${m.app_id} not found in ${m.source_region}`);
    // Copy the whole row by column name so app state (paused*, organization_id,
    // deployment_backend, anon_key, access/AI/JWT config, ...) survives the move
    // and new columns are carried automatically. Only the move-specific fields
    // are overridden. Columns the destination region lacks are dropped by
    // json_populate_record; runtime migrations run on every region, so the
    // shapes match in practice.
    const row = {
      ...src.rows[0].row,
      db_name: String(src.rows[0].row.db_name) + '__pending',
      region: m.dest_region,
      provisioning_status: 'migration_target_reserved',
    };
    await destPool.query(
      `INSERT INTO apps SELECT * FROM json_populate_record(NULL::apps, $1::json)
       ON CONFLICT (id) DO UPDATE
         SET region = EXCLUDED.region,
             provisioning_status = 'migration_target_reserved'`,
      [JSON.stringify(row)],
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
