import type pg from 'pg';

/**
 * The prose window that led to an approval.
 *
 * Deliberately narrow: user and assistant text, ending at the assistant turn
 * that raised the gate. Tool rows, tool args and tool results never leave the
 * server. The operator conversation is one per org forever, so `limit` is a
 * window, not the whole transcript.
 */
export interface ApprovalConversationMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
}

export async function listApprovalConversation(
  pool: pg.Pool,
  input: {
    conversationId: string;
    turnMessageId: string;
    approvalCreatedAt: Date;
    limit: number;
  },
): Promise<{ messages: ApprovalConversationMessage[]; truncated: boolean }> {
  const limit = Math.max(1, Math.min(50, Math.floor(input.limit)));
  const result = await pool.query<{
    id: string;
    role: 'user' | 'assistant';
    content: string;
    created_at: Date | string;
  }>(
    `WITH turn AS (
       SELECT created_at
         FROM dashboard_agent_messages
        WHERE id = $2 AND conversation_id = $1
     )
     SELECT id, role, content, created_at
       FROM dashboard_agent_messages
      WHERE conversation_id = $1
        AND role IN ('user','assistant')
        AND content IS NOT NULL AND btrim(content) <> ''
        AND created_at <= COALESCE((SELECT created_at FROM turn), $3)
      ORDER BY created_at DESC, id DESC
      LIMIT $4`,
    [input.conversationId, input.turnMessageId, input.approvalCreatedAt, limit + 1],
  );

  const truncated = result.rows.length > limit;
  const window = truncated ? result.rows.slice(0, limit) : result.rows;

  return {
    messages: window.reverse().map((row) => ({
      id: row.id,
      role: row.role,
      content: row.content,
      created_at:
        row.created_at instanceof Date
          ? row.created_at.toISOString()
          : new Date(row.created_at).toISOString(),
    })),
    truncated,
  };
}
