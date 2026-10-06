import type pg from 'pg';

/**
 * Count leases marked 'abandoned' whose expiry is older than `olderThanSeconds`.
 * Under reserve-small these represent jobs that consumed upstream capacity but
 * were never billed — a revenue leak, not a hygiene problem.
 */
export async function countAgedUnsettled(
  platformPool: pg.Pool,
  olderThanSeconds: number,
): Promise<number> {
  const r = await platformPool.query<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM credit_leases
      WHERE status = 'abandoned'
        AND expires_at < now() - ($1 || ' seconds')::interval`,
    [String(olderThanSeconds)],
  );
  return parseInt(r.rows[0].n, 10);
}
