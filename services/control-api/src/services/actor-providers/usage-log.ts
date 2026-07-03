import type pg from 'pg';

export interface ActorUsageRow {
  appId: string;
  organizationId: string;
  userId: string | null;
  providerKey: string;
  actorId: string;
  dimension: 'recording' | 'transcription';
  seconds: number;
  usdCost: number;
  usdCharged: number;
  markupPct: number;
  leaseId: string | null;
  requestMetadata: Record<string, unknown>;
}

/**
 * INSERT with ON CONFLICT DO NOTHING — the (actor_id, dimension) unique constraint
 * makes settlement idempotent across webhook retries. Returns true if a row was
 * inserted (caller should settle the lease), false if it was a duplicate (caller
 * should skip settlement).
 */
export async function writeActorUsageRow(
  runtimePool: pg.Pool,
  row: ActorUsageRow,
): Promise<boolean> {
  const res = await runtimePool.query(
    `INSERT INTO actor_usage_logs (
       app_id, user_id, provider_key, actor_id, dimension, seconds,
       usd_cost, usd_charged, markup_pct, lease_id, request_metadata, organization_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (actor_id, dimension) DO NOTHING`,
    [
      row.appId, row.userId, row.providerKey, row.actorId, row.dimension, row.seconds,
      row.usdCost, row.usdCharged, row.markupPct, row.leaseId,
      JSON.stringify(row.requestMetadata),
      row.organizationId,
    ],
  );
  return (res.rowCount ?? 0) > 0;
}
