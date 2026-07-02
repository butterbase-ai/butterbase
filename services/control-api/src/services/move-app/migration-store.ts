import type pg from 'pg';
import { resolveOrganizationId } from '../org-resolver.js';

export const HAPPY_PATH_ORDER = [
  'requested',
  'reserving_dest',
  'blocking_writes',
  'dumping_data',
  'restoring_data',
  'dumping_kv',
  'restoring_kv',
  'copying_blobs',
  'copying_runtime',
  'flipping_routing',
  'setting_up_reverse_replication',
  'unblocking_writes',
  'completed',
] as const;

export type Step = (typeof HAPPY_PATH_ORDER)[number] | 'aborting' | 'aborted' | 'failed';

export interface MigrationRow {
  id: string;
  app_id: string;
  user_id: string;
  source_region: string;
  dest_region: string;
  current_step: Step;
  step_started_at: Date;
  last_error: string | null;
  retry_count: number;
  dest_resources: Record<string, any>;
  source_replica_state: 'none' | 'replicating' | 'torn_down' | null;
  initiated_at: Date;
  completed_at: Date | null;
}

export interface CreateArgs {
  appId: string;
  userId: string;
  sourceRegion: string;
  destRegion: string;
}

export async function createMigration(controlPool: pg.Pool, args: CreateArgs): Promise<string> {
  const organizationId = await resolveOrganizationId(controlPool, args.userId);
  const r = await controlPool.query<{ id: string }>(
    `INSERT INTO app_migrations (app_id, user_id, organization_id, source_region, dest_region)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [args.appId, args.userId, organizationId, args.sourceRegion, args.destRegion],
  );
  return r.rows[0].id;
}

export async function getMigration(controlPool: pg.Pool, id: string): Promise<MigrationRow | null> {
  const r = await controlPool.query<MigrationRow>(
    `SELECT * FROM app_migrations WHERE id = $1`, [id],
  );
  return r.rows[0] ?? null;
}

function isLegalTransition(from: Step, to: Step): boolean {
  if (to === 'aborting' || to === 'failed') return true;
  if (from === 'aborting' && to === 'aborted') return true;
  const i = HAPPY_PATH_ORDER.indexOf(from as any);
  const j = HAPPY_PATH_ORDER.indexOf(to as any);
  if (i < 0 || j < 0) return false;
  return j === i + 1 || j === i;
}

export async function advanceStep(
  controlPool: pg.Pool,
  id: string,
  nextStep: Step,
  destResourcesPatch: Record<string, any>,
): Promise<void> {
  const m = await getMigration(controlPool, id);
  if (!m) throw new Error(`migration ${id} not found`);
  if (!isLegalTransition(m.current_step, nextStep)) {
    throw new Error(`illegal transition: ${m.current_step} → ${nextStep}`);
  }
  await controlPool.query(
    `UPDATE app_migrations
     SET current_step = $2,
         step_started_at = now(),
         retry_count = 0,
         last_error = NULL,
         dest_resources = dest_resources || $3::jsonb
     WHERE id = $1`,
    [id, nextStep, JSON.stringify(destResourcesPatch)],
  );
}

export async function recordError(controlPool: pg.Pool, id: string, error: string): Promise<void> {
  await controlPool.query(
    `UPDATE app_migrations
     SET last_error = $2, retry_count = retry_count + 1
     WHERE id = $1`,
    [id, error],
  );
}

export async function markCompleted(controlPool: pg.Pool, id: string): Promise<void> {
  await controlPool.query(
    `UPDATE app_migrations
     SET current_step = 'completed', completed_at = now()
     WHERE id = $1`,
    [id],
  );
}

export async function markAborted(controlPool: pg.Pool, id: string, reason: string): Promise<void> {
  await controlPool.query(
    `UPDATE app_migrations
     SET current_step = 'aborted', last_error = $2, completed_at = now()
     WHERE id = $1`,
    [id, reason],
  );
}

export async function setSourceReplicaState(
  controlPool: pg.Pool,
  id: string,
  state: 'none' | 'replicating' | 'torn_down',
): Promise<void> {
  await controlPool.query(
    `UPDATE app_migrations SET source_replica_state = $2 WHERE id = $1`,
    [id, state],
  );
}
