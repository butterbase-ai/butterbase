// services/control-api/src/services/move-app/saga-executor.ts
import type pg from 'pg';
import type { Redis } from 'ioredis';
import {
  HAPPY_PATH_ORDER,
  type MigrationRow,
} from './migration-store.js';

const MAX_RETRIES_PER_STEP = 5;

/**
 * Steps that are safe to auto-abort & compensate when retries exhaust.
 * After flipping_routing, the dest region is authoritative — auto-aborting
 * would lose data. Those steps go straight to 'failed' for manual review.
 */
const AUTO_ABORTABLE_STEPS = new Set([
  'requested',
  'reserving_dest',
  'blocking_writes',
  'dumping_data',
  'restoring_data',
  'dumping_kv',
  'restoring_kv',
  'copying_blobs',
  'copying_runtime',
]);

export interface SagaCtx {
  controlPool: pg.Pool;
  runtimePoolFor: (region: string) => pg.Pool;
  redisFor: (region: string) => Redis;
  log: { info: Function; warn: Function; error: Function };
}

export type StepHandler = (ctx: SagaCtx, m: MigrationRow) => Promise<{
  next: string;
  patch: Record<string, any>;
  sourceReplicaState?: 'none' | 'replicating' | 'torn_down';
}>;

export type StepHandlerMap = Partial<Record<string, StepHandler>>;

export async function driveOnce(ctx: SagaCtx, handlers: StepHandlerMap): Promise<void> {
  const client = await ctx.controlPool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<MigrationRow>(
      `SELECT * FROM app_migrations
       WHERE current_step NOT IN ('completed','aborted','failed')
       ORDER BY step_started_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1`,
    );
    if (rows.length === 0) {
      await client.query('COMMIT');
      return;
    }
    const m = rows[0];

    if (m.retry_count >= MAX_RETRIES_PER_STEP) {
      // Steps before flipping_routing are safe to auto-revert. Transition
      // to 'aborting' so the abort handler runs compensation on the next
      // tick. Steps after flipping_routing aren't reversible without data
      // loss; mark 'failed' for manual review.
      const nextStep = AUTO_ABORTABLE_STEPS.has(m.current_step) ? 'aborting' : 'failed';
      await client.query(
        `UPDATE app_migrations
         SET current_step = $2, step_started_at = now(), retry_count = 0
         WHERE id = $1`,
        [m.id, nextStep],
      );
      ctx.log.error(
        { migrationId: m.id, step: m.current_step, next: nextStep },
        nextStep === 'aborting'
          ? 'move-app step exceeded retries; transitioning to aborting for compensation'
          : 'move-app step exceeded retries; marked failed (post-flip, manual review required)',
      );
      await client.query('COMMIT');
      return;
    }

    const handler = handlers[m.current_step];
    if (!handler) {
      await client.query('COMMIT');
      ctx.log.warn({ step: m.current_step, migrationId: m.id }, 'no step handler registered; skipping tick');
      return;
    }

    try {
      const { next, patch, sourceReplicaState } = await handler(ctx, m);
      if (next === 'completed') {
        await client.query(
          `UPDATE app_migrations
           SET current_step = 'completed', completed_at = now(),
               dest_resources = dest_resources || $2::jsonb,
               source_replica_state = COALESCE($3, source_replica_state)
           WHERE id = $1`,
          [m.id, JSON.stringify(patch), sourceReplicaState ?? null],
        );
      } else if (next === 'aborted') {
        // Compensation finished; mark terminal. Treat like 'completed' but
        // distinct status so operators can tell rollbacks from successes.
        await client.query(
          `UPDATE app_migrations
           SET current_step = 'aborted', completed_at = now(),
               dest_resources = dest_resources || $2::jsonb
           WHERE id = $1`,
          [m.id, JSON.stringify(patch)],
        );
      } else {
        const i = HAPPY_PATH_ORDER.indexOf(m.current_step as any);
        const j = HAPPY_PATH_ORDER.indexOf(next as any);
        if (next !== 'aborting' && next !== 'failed' && j < 0) {
          throw new Error(`unknown next step "${next}"`);
        }
        if (next !== 'aborting' && next !== 'failed' && j !== i + 1 && j !== i) {
          throw new Error(`illegal transition: ${m.current_step} → ${next}`);
        }
        await client.query(
          `UPDATE app_migrations
           SET current_step = $2, step_started_at = now(), retry_count = 0, last_error = NULL,
               dest_resources = dest_resources || $3::jsonb,
               source_replica_state = COALESCE($4, source_replica_state)
           WHERE id = $1`,
          [m.id, next, JSON.stringify(patch), sourceReplicaState ?? null],
        );
      }
      await client.query('COMMIT');
      ctx.log.info({ migrationId: m.id, from: m.current_step, to: next }, 'move-app step advanced');
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      await client.query(
        `UPDATE app_migrations SET last_error = $2, retry_count = retry_count + 1 WHERE id = $1`,
        [m.id, msg],
      );
      await client.query('COMMIT');
      ctx.log.warn({ migrationId: m.id, step: m.current_step, err: msg }, 'move-app step failed; will retry');
    }
  } catch (outer) {
    await client.query('ROLLBACK').catch(() => {});
    throw outer;
  } finally {
    client.release();
  }
}
