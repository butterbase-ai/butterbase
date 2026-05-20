import type pg from 'pg';
import { setSourceReplicaState } from './migration-store.js';
import { dropReplicationObjects } from './neon-replication.js';

/**
 * Enqueue a deprovision task for an app's source-region Neon database.
 * The neon-task-worker picks this up and calls deleteDatabase via the Neon API.
 * `region` and `neonDbName` are accepted for API compatibility but the worker
 * resolves DB details from app_db_connections using app_id.
 */
export async function enqueueDeprovision(
  controlPool: pg.Pool,
  _region: string,
  appId: string,
  _neonDbName: string,
): Promise<void> {
  await controlPool.query(
    `INSERT INTO neon_tasks (app_id, task_type)
     VALUES ($1, 'deprovision')`,
    [appId],
  );
}

export interface SourceReplicaRow {
  migration_id: string;
  app_id: string;
  source_region: string;
  dest_region: string;
  completed_at: string;
  estimated_monthly_cost_usd: number;
}

export async function listActiveSourceReplicas(
  controlPool: pg.Pool, userId: string,
): Promise<SourceReplicaRow[]> {
  const { rows } = await controlPool.query<SourceReplicaRow>(
    `SELECT id AS migration_id, app_id, source_region, dest_region, completed_at,
            (dest_resources ->> 'dump_bytes')::bigint::float / (1024*1024*1024) * 0.50 AS estimated_monthly_cost_usd
     FROM app_migrations
     WHERE user_id = $1
       AND source_replica_state = 'replicating'
       AND current_step = 'completed'
     ORDER BY completed_at DESC`,
    [userId],
  );
  return rows;
}

export interface TeardownCtx {
  enqueueDeprovision: (region: string, appId: string, neonDbName: string) => Promise<void>;
}

export async function teardownSourceReplica(
  ctx: TeardownCtx & { controlPool: pg.Pool },
  migrationId: string,
): Promise<void> {
  const { rows } = await ctx.controlPool.query<{
    app_id: string; source_region: string; dest_region: string; dest_resources: any; source_replica_state: string;
  }>(`SELECT app_id, source_region, dest_region, dest_resources, source_replica_state FROM app_migrations WHERE id = $1`, [migrationId]);
  if (rows.length === 0) throw new Error('migration not found');
  if (rows[0].source_replica_state !== 'replicating') {
    throw new Error(`cannot teardown replica in state ${rows[0].source_replica_state}`);
  }

  // Drop replication objects before destroying the source DB so the
  // subscription/publication are gone before deprovision runs.
  if (process.env.MOVE_APP_REPLICATION_ENABLED === 'true') {
    await dropReplicationObjects({
      sourceRegion: rows[0].source_region,
      destRegion: rows[0].dest_region,
      appId: rows[0].app_id,
      migrationId,
    });
  }

  await ctx.enqueueDeprovision(rows[0].source_region, rows[0].app_id, '');
  await setSourceReplicaState(ctx.controlPool, migrationId, 'torn_down');
}
