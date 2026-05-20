import type pg from 'pg';
import type { OutboxField } from './state-outbox.js';

const BATCH_SIZE = 100;

export interface DrainContext {
  platformPool: pg.Pool;
  runtimePoolsByRegion: Record<string, pg.Pool>;
}

export interface DrainResult {
  processed: number;
  errors: Array<{ rowId: number; region: string; error: string }>;
}

/**
 * Apply one outbox row's fields to a region's user_billing_state. Uses the
 * version number to prevent older versions overwriting newer ones (out-of-order
 * safe). Idempotent — can be called multiple times for the same (user, version).
 */
export async function applyVersionToRegion(
  runtimePool: pg.Pool,
  userId: string,
  version: number,
  fields: Partial<Record<OutboxField, string | number | null>>
): Promise<void> {
  const keys = Object.keys(fields) as OutboxField[];
  const setColumns = keys.map((k, i) => `${k} = $${i + 3}`).join(', ');
  const values = keys.map((k) => fields[k] ?? null);

  const insertCols = ['user_id', 'last_outbox_version', ...keys].join(', ');
  const insertVals = ['$1', '$2', ...keys.map((_, i) => `$${i + 3}`)].join(', ');
  const updateCols = `${setColumns}, last_outbox_version = $2, updated_at = now()`;

  await runtimePool.query(
    `INSERT INTO user_billing_state (${insertCols})
     VALUES (${insertVals})
     ON CONFLICT (user_id) DO UPDATE
     SET ${updateCols}
     WHERE user_billing_state.last_outbox_version < EXCLUDED.last_outbox_version`,
    [userId, version, ...values]
  );
}

export async function drainOnce(ctx: DrainContext): Promise<DrainResult> {
  const allRegions = Object.keys(ctx.runtimePoolsByRegion);
  const result: DrainResult = { processed: 0, errors: [] };

  const client = await ctx.platformPool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query<{
      id: number;
      user_id: string;
      fields_changed: Record<OutboxField, string | number | null>;
      version: string;
      applied_to_regions: string[];
    }>(
      `SELECT id, user_id, fields_changed, version, applied_to_regions
       FROM user_state_outbox
       WHERE done_at IS NULL
       ORDER BY created_at
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [BATCH_SIZE]
    );

    for (const row of rows) {
      const version = parseInt(row.version, 10);
      const missing = allRegions.filter((r) => !row.applied_to_regions.includes(r));

      for (const region of missing) {
        try {
          await applyVersionToRegion(ctx.runtimePoolsByRegion[region], row.user_id, version, row.fields_changed);
          await client.query(
            `UPDATE user_state_outbox
             SET applied_to_regions = array_append(applied_to_regions, $2)
             WHERE id = $1 AND NOT ($2 = ANY(applied_to_regions))`,
            [row.id, region]
          );
        } catch (err) {
          result.errors.push({
            rowId: row.id,
            region,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const { rows: check } = await client.query<{ applied_to_regions: string[] }>(
        `SELECT applied_to_regions FROM user_state_outbox WHERE id = $1`,
        [row.id]
      );
      const covered = check[0]?.applied_to_regions ?? [];
      if (allRegions.every((r) => covered.includes(r))) {
        await client.query(
          `UPDATE user_state_outbox SET done_at = now() WHERE id = $1 AND done_at IS NULL`,
          [row.id]
        );
      }
      result.processed++;
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  return result;
}

export async function pruneOldOutboxRows(
  platformPool: pg.Pool,
  retentionDays: number
): Promise<{ deleted: number }> {
  const r = await platformPool.query(
    `DELETE FROM user_state_outbox
     WHERE done_at IS NOT NULL AND done_at < now() - ($1 || ' days')::interval`,
    [String(retentionDays)]
  );
  return { deleted: r.rowCount ?? 0 };
}
