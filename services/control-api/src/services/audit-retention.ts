import type pg from 'pg';
import { performance } from 'node:perf_hooks';

export interface AuditRetentionOptions {
  cutoff?: Date;
  batchSize?: number;
  maxBatches?: number;
  budgetMs?: number;
  now?: () => number;
}
export interface AuditRetentionResult {
  deletedRows: number;
  batches: number;
  limited: boolean;
}

/** Each batch commits independently; locked rows remain eligible for later passes. */
export async function pruneAuditEvents(pool: pg.Pool, options: AuditRetentionOptions = {}): Promise<AuditRetentionResult> {
  const batchSize = options.batchSize ?? 1000;
  const maxBatches = options.maxBatches ?? 1000;
  const budgetMs = options.budgetMs ?? 30_000;
  for (const [name, value, maximum] of [
    ['batchSize', batchSize, 10_000], ['maxBatches', maxBatches, 10_000], ['budgetMs', budgetMs, 300_000],
  ] as const) {
    if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error(`Invalid audit retention ${name}`);
  }
  if (options.cutoff && !Number.isFinite(options.cutoff.getTime())) throw new Error('Invalid audit retention cutoff');
  const now = options.now ?? (() => performance.now());
  const started = now();
  // Preserve the database's calendar/clock semantics for the existing policy.
  const cutoff = options.cutoff ?? (await pool.query<{ cutoff: Date }>(
    "SELECT now() - interval '180 days' AS cutoff",
  )).rows[0].cutoff;
  let batches = 0, deletedRows = 0;
  while (batches < maxBatches && now() - started < budgetMs) {
    const result = await pool.query(`WITH expired AS (
      SELECT id FROM public.audit_events WHERE created_at<$1
      ORDER BY created_at,id LIMIT $2 FOR UPDATE SKIP LOCKED
    ) DELETE FROM public.audit_events a USING expired WHERE a.id=expired.id`, [cutoff, batchSize]);
    const deleted = result.rowCount ?? 0;
    batches++; deletedRows += deleted;
    if (deleted < batchSize) return { deletedRows, batches, limited: false };
  }
  // This signals an admission limit, not a count of rows remaining/locked.
  return { deletedRows, batches, limited: true };
}
