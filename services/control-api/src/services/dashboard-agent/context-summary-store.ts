import pg from 'pg';

/**
 * The stored compaction summary for one conversation.
 *
 * `throughMessageId` / `throughCreatedAt` are the watermark: the last message
 * the summary covers. Replay drops rows up to and including it and prepends
 * `summary`. One row per conversation; re-compaction updates it in place.
 */
export type ContextSummary = {
  conversationId: string;
  summary: string;
  throughMessageId: string;
  throughCreatedAt: Date;
  sourceCharacters: number;
  summaryCharacters: number;
  modelUsed: string | null;
  updatedAt: Date;
};

export async function getContextSummary(
  pool: pg.Pool,
  conversationId: string,
): Promise<ContextSummary | null> {
  const result = await pool.query(
    `SELECT conversation_id, summary, through_message_id, through_created_at,
            source_characters, summary_characters, model_used, updated_at
       FROM dashboard_agent_context_summaries
      WHERE conversation_id = $1`,
    [conversationId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    conversationId: row.conversation_id,
    summary: row.summary,
    throughMessageId: row.through_message_id,
    throughCreatedAt: new Date(row.through_created_at),
    sourceCharacters: Number(row.source_characters),
    summaryCharacters: row.summary_characters,
    modelUsed: row.model_used ?? null,
    updatedAt: new Date(row.updated_at),
  };
}

export async function upsertContextSummary(
  pool: pg.Pool,
  input: Omit<ContextSummary, 'updatedAt'>,
): Promise<void> {
  await pool.query(
    `INSERT INTO dashboard_agent_context_summaries
       (conversation_id, summary, through_message_id, through_created_at,
        source_characters, summary_characters, model_used)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (conversation_id) DO UPDATE SET
       summary = EXCLUDED.summary,
       through_message_id = EXCLUDED.through_message_id,
       through_created_at = EXCLUDED.through_created_at,
       source_characters = EXCLUDED.source_characters,
       summary_characters = EXCLUDED.summary_characters,
       model_used = EXCLUDED.model_used,
       updated_at = NOW()`,
    [
      input.conversationId,
      input.summary,
      input.throughMessageId,
      input.throughCreatedAt,
      input.sourceCharacters,
      input.summaryCharacters,
      input.modelUsed,
    ],
  );
}
