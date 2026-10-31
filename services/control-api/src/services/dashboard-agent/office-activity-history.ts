import type pg from 'pg';
import { OFFICE_ACTIVITY_HISTORY_MAX_CALLS, OFFICE_ACTIVITY_HISTORY_MAX_GROUPS, projectOfficeConversationActivity } from './office-activity.js';

type HistoryRow = { id: string; role: string; content: string; created_at: Date; tool_call_id?: string | null;
  tool_name?: string | null; tool_args?: unknown; tool_result?: unknown; pending_approval_id?: string | null; outcome?: string | null; final_answer_id?: string | null };

/** Caller must authorize the conversation first. Limit counts the same latest
 * user/assistant rows as the existing public conversation reader, including empty
 * paired assistant rows. Only user anchors inside that window receive activity.
 * Pairs are selected by call identity, never by a raw transcript row cutoff. */
export async function readOfficeConversationActivityHistory(pool: pg.Pool, conversationId: string, limit = 25) {
  if (!Number.isInteger(limit) || limit < 1 || limit > OFFICE_ACTIVITY_HISTORY_MAX_GROUPS) throw new RangeError('Invalid history limit');
  const window = await pool.query<HistoryRow>(`/* office_activity_window */
    SELECT m.id,m.role,m.content,m.created_at,t.outcome,t.final_answer_id FROM dashboard_agent_messages m
    LEFT JOIN dashboard_agent_office_turns t ON t.user_message_id=m.id AND t.conversation_id=m.conversation_id
    WHERE m.conversation_id=$1 AND role IN ('user','assistant')
    ORDER BY m.created_at DESC,m.id DESC LIMIT $2`, [conversationId, limit]);
  const messages = window.rows.reverse().filter(m => m.content?.trim()).map(m => ({
    id: m.id, role: m.role, content: m.content, createdAt: m.created_at,
  }));
  const userIds = messages.filter(m => m.role === 'user').map(m => m.id);
  const turns = window.rows.filter(m => m.role === 'user' && userIds.includes(m.id)).map(m => ({ user_message_id: m.id, outcome: m.outcome ?? 'unknown', final_answer_id: m.final_answer_id ?? null }));
  if (!userIds.length) return { messages, activity: [], turns };
  const pairs = await pool.query<HistoryRow>(`/* office_activity_pairs */
    WITH anchors AS MATERIALIZED (
      SELECT u.id,u.created_at,n.id AS next_id,n.created_at AS next_at
      FROM dashboard_agent_messages u
      LEFT JOIN LATERAL (
        SELECT id,created_at FROM dashboard_agent_messages
        WHERE conversation_id=$1 AND role='user' AND btrim(content)<>'' AND (created_at,id)>(u.created_at,u.id)
        ORDER BY created_at,id LIMIT 1
      ) n ON true
      WHERE u.conversation_id=$1 AND u.role='user' AND u.id=ANY($2::uuid[])
    ), calls AS MATERIALIZED (
      SELECT c.* FROM anchors u CROSS JOIN LATERAL (
        SELECT a.id,a.role,a.tool_call_id,a.tool_name,
          jsonb_build_object('action',a.tool_args->'action','capability',a.tool_args->'capability') AS tool_args,
          a.pending_approval_id,a.created_at
        FROM dashboard_agent_messages a
        WHERE a.conversation_id=$1 AND a.role='assistant' AND a.tool_call_id IS NOT NULL AND a.tool_name IS NOT NULL
          AND (a.created_at,a.id)>(u.created_at,u.id)
          AND (u.next_id IS NULL OR (a.created_at,a.id)<(u.next_at,u.next_id))
        ORDER BY a.created_at DESC,a.id DESC LIMIT 32
      ) c ORDER BY c.created_at DESC,c.id DESC LIMIT $3
    )
    SELECT id,'user' AS role,NULL::text AS tool_call_id,NULL::text AS tool_name,NULL::jsonb AS tool_args,
      NULL::jsonb AS tool_result,NULL::uuid AS pending_approval_id,created_at FROM anchors
    UNION ALL
    SELECT id,role,tool_call_id,tool_name,tool_args,NULL::jsonb,pending_approval_id,created_at FROM calls
    UNION ALL
    SELECT r.id,r.role,r.tool_call_id,r.tool_name,NULL::jsonb,
      CASE WHEN octet_length(r.tool_result::text)<=65536 THEN r.tool_result ELSE NULL END,
      NULL::uuid,r.created_at
    FROM calls c CROSS JOIN LATERAL (
      SELECT id,role,tool_call_id,tool_name,tool_result,created_at FROM dashboard_agent_messages
      WHERE conversation_id=$1 AND role='tool' AND tool_call_id=c.tool_call_id AND created_at>=c.created_at
      ORDER BY created_at,id LIMIT 1
    ) r
    ORDER BY created_at,id`, [conversationId, userIds, OFFICE_ACTIVITY_HISTORY_MAX_CALLS]);
  return { messages, turns, activity: projectOfficeConversationActivity(pairs.rows.map(m => ({
    id: m.id, role: m.role, createdAt: m.created_at, toolCallId: m.tool_call_id,
    toolName: m.tool_name, toolArgs: m.tool_args, toolResult: m.tool_result, pendingApprovalId: m.pending_approval_id,
  }))) };
}
