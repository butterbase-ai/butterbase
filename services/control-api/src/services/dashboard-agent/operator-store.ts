import pg from 'pg';
import { createConversation } from './store.js';

/** Sentinel identity for headless turns. user_id is TEXT, so this is valid. */
export function operatorUserId(orgId: string): string {
  return `operator:${orgId}`;
}

export type OperatorJob = {
  id: string;
  organizationId: string;
  name: string;
  instructions: string;
  intervalSeconds: number;
};

export async function getOrCreateOperatorConversation(
  pool: pg.Pool,
  orgId: string,
  model: string,
): Promise<string> {
  const existing = await pool.query<{ id: string }>(
    `SELECT id FROM dashboard_agent_conversations
     WHERE organization_id = $1 AND user_id = $2
     ORDER BY created_at ASC LIMIT 1`,
    [orgId, operatorUserId(orgId)],
  );
  if (existing.rows.length > 0) return existing.rows[0].id;

  const conv = await createConversation(pool, operatorUserId(orgId), 'Operator', model);
  await pool.query(
    `UPDATE dashboard_agent_conversations SET organization_id = $1 WHERE id = $2`,
    [orgId, conv.id],
  );
  return conv.id;
}

/**
 * Claim due jobs and advance next_run_at in one transaction.
 * FOR UPDATE SKIP LOCKED mirrors attention-rule-evaluator so concurrent
 * workers never double-claim.
 */
export async function claimDueJobs(
  pool: pg.Pool,
  limit: number,
  now: Date = new Date(),
): Promise<OperatorJob[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const res = await client.query<{
      id: string;
      organization_id: string;
      name: string;
      instructions: string;
      interval_seconds: number;
    }>(
      `SELECT id, organization_id, name, instructions, interval_seconds
       FROM dashboard_agent_operator_jobs
       WHERE enabled = TRUE AND next_run_at <= $1
       ORDER BY next_run_at
       LIMIT $2
       FOR UPDATE SKIP LOCKED`,
      [now, limit],
    );

    for (const row of res.rows) {
      await client.query(
        `UPDATE dashboard_agent_operator_jobs
         SET last_run_at = $1::timestamptz, next_run_at = $1::timestamptz + make_interval(secs => $2)
         WHERE id = $3`,
        [now, row.interval_seconds, row.id],
      );
    }

    await client.query('COMMIT');
    return res.rows.map((r) => ({
      id: r.id,
      organizationId: r.organization_id,
      name: r.name,
      instructions: r.instructions,
      intervalSeconds: r.interval_seconds,
    }));
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
