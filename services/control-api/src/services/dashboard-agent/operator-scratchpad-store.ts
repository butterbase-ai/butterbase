import pg from 'pg';

/**
 * Per-org operator scratchpad: cheap, agent-authored working memory the
 * operator reads into its wake prompt (migration 097/005). Substrate remains
 * the source of truth for durable state — this is a working digest, not a
 * replacement for it. One row per org; a write REPLACES the prior content,
 * it does not append to it.
 *
 * RULE (see progress.md, ENABLE-LIST ROUND): this content is model-written
 * and MUST NEVER be an input to a security decision — trusting it would let
 * the agent influence its own gating.
 */

/**
 * Hard cap on scratchpad content, in characters. Mirrors the CHECK
 * constraint on dashboard_agent_operator_scratchpad.content — kept in sync
 * intentionally so the write path fails the SAME way the schema would, with
 * a clear error instead of a raw Postgres constraint violation surfacing
 * from deep in a wake turn.
 *
 * Sizing: this is model-written on a 10-minute cadence with no natural
 * limit (unlike a human editing a note, nothing stops the model from
 * re-writing a slightly longer version every wake). 8000 characters
 * (~2-3k tokens) is enough for a standing-facts-and-open-threads digest
 * while staying a small, bounded slice of the wake prompt — not a place for
 * the operator to accumulate history that belongs in substrate. The write
 * path REJECTS oversized content rather than silently truncating it:
 * truncation would silently drop whichever part of the agent's own summary
 * didn't fit, with no signal that anything was lost.
 */
export const OPERATOR_SCRATCHPAD_MAX_CHARS = 8000;

export type OperatorScratchpad = {
  organizationId: string;
  content: string;
  updatedAt: string;
};

function rowToScratchpad(row: any): OperatorScratchpad {
  return {
    organizationId: row.organization_id,
    content: row.content,
    updatedAt: row.updated_at,
  };
}

/**
 * Read the scratchpad for an org. Returns null if the org has never written
 * one (not an empty-string row — no INSERT has happened yet).
 */
export async function getOperatorScratchpad(
  pool: pg.Pool,
  orgId: string,
): Promise<OperatorScratchpad | null> {
  const result = await pool.query(
    `SELECT organization_id, content, updated_at
     FROM dashboard_agent_operator_scratchpad
     WHERE organization_id = $1`,
    [orgId],
  );
  return result.rows.length === 0 ? null : rowToScratchpad(result.rows[0]);
}

/**
 * Replace the scratchpad for an org (upsert — one row per org, not an
 * append). Throws if content exceeds OPERATOR_SCRATCHPAD_MAX_CHARS; see the
 * constant's comment for why this rejects rather than truncates.
 */
export async function setOperatorScratchpad(
  pool: pg.Pool,
  orgId: string,
  content: string,
): Promise<OperatorScratchpad> {
  if (content.length > OPERATOR_SCRATCHPAD_MAX_CHARS) {
    throw new Error(
      `operator scratchpad content exceeds ${OPERATOR_SCRATCHPAD_MAX_CHARS} characters (got ${content.length})`,
    );
  }

  const result = await pool.query(
    `INSERT INTO dashboard_agent_operator_scratchpad (organization_id, content, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (organization_id) DO UPDATE
       SET content = EXCLUDED.content, updated_at = now()
     RETURNING organization_id, content, updated_at`,
    [orgId, content],
  );
  return rowToScratchpad(result.rows[0]);
}
