import pg from 'pg';

/** Sentinel identity for headless turns. user_id is TEXT, so this is valid. */
export function operatorUserId(orgId: string): string {
  return `operator:${orgId}`;
}

/**
 * The sentinel's prefix, DERIVED from `operatorUserId` rather than written out
 * a second time. There is exactly one literal `operator:` in this repo and it
 * is above; a drift guard (__tests__/operator-turn.test.ts) pins the format.
 */
const OPERATOR_USER_ID_PREFIX = operatorUserId('');

/**
 * Is this turn running under the headless operator identity?
 *
 * Deliberately a PREFIX test rather than an equality test against
 * `operatorUserId(orgId)`. `runAgentTurn`'s `organizationId` is optional, so an
 * equality test would answer "not an operator" — i.e. fail OPEN, ungoverned —
 * for any caller that supplies the sentinel user id but omits the org. The
 * prefix cannot be produced by a real user id (those are Cognito subs), so the
 * only way to be mistaken for an operator is to already be one.
 */
export function isOperatorUserId(userId: unknown): boolean {
  return typeof userId === 'string' && userId.startsWith(OPERATOR_USER_ID_PREFIX);
}

export type OperatorJob = {
  id: string;
  organizationId: string;
  name: string;
  instructions: string;
  intervalSeconds: number;
};

/**
 * SELECT-first fast path, then an atomic INSERT that writes organization_id
 * inline (no separate UPDATE, so there is never a window where the row
 * exists with organization_id = NULL). ON CONFLICT DO NOTHING resolves a
 * lost race to the winner's row via dashboard_agent_conversations_operator_uniq
 * (organization_id, user_id) rather than erroring or double-inserting.
 */
export async function getOrCreateOperatorConversation(
  pool: pg.Pool,
  orgId: string,
  model: string,
): Promise<string> {
  const userId = operatorUserId(orgId);

  const existing = await pool.query<{ id: string }>(
    `SELECT id FROM dashboard_agent_conversations
     WHERE organization_id = $1 AND user_id = $2
     ORDER BY created_at ASC LIMIT 1`,
    [orgId, userId],
  );
  if (existing.rows.length > 0) return existing.rows[0].id;

  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO dashboard_agent_conversations (organization_id, user_id, title, model)
     VALUES ($1, $2, 'Operator', $3)
     ON CONFLICT (organization_id, user_id) WHERE organization_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [orgId, userId, model],
  );
  if (inserted.rows.length > 0) return inserted.rows[0].id;

  // Someone else won the race between our SELECT and our INSERT.
  const winner = await pool.query<{ id: string }>(
    `SELECT id FROM dashboard_agent_conversations
     WHERE organization_id = $1 AND user_id = $2
     ORDER BY created_at ASC LIMIT 1`,
    [orgId, userId],
  );
  return winner.rows[0].id;
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
