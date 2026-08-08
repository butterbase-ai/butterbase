import pg from 'pg';

/**
 * PostgreSQL rejects NUL (U+0000) inside JSONB — `unsupported Unicode escape
 * sequence`. Any tool result containing one makes the INSERT throw, and where
 * that INSERT is the row that completes an assistant/tool pair, the throw
 * leaves the conversation permanently invalid (see completeApprovalResolution
 * in resume.ts). Strip NULs from keys and values so a value that reached the
 * persistence boundary can always be written.
 *
 * This is a property of the WRITE, not of the value: callers that execute a
 * tool still receive the raw, unsanitised result. Those stripped bytes are the
 * only way a persisted or replayed result can differ from a fresh one.
 *
 * Single source of truth — tool-bridge.ts's execution cache uses this same
 * function. Do not fork a second copy.
 */
export function stripJsonbNulls(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(/\u0000/g, '');
  if (Array.isArray(value)) return value.map(stripJsonbNulls);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k.replace(/\u0000/g, '')] = stripJsonbNulls(v);
    }
    return out;
  }
  return value;
}

export type Conversation = {
  id: string;
  userId: string;
  title: string;
  model: string;
  createdAt: Date;
  updatedAt: Date;
  lastMessageAt: Date | null;
  pinnedAt: Date | null;
};

export type Message = {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolCallId: string | null;
  toolName: string | null;
  toolArgs: unknown | null;
  toolResult: unknown | null;
  modelUsed: string | null;
  pendingApprovalId: string | null;
  rating: 1 | -1 | 0 | null;
  ratingReason: string | null;
  createdAt: Date;
};

/**
 * Create a new conversation for a user
 */
export async function createConversation(
  pool: pg.Pool,
  userId: string,
  title: string,
  model: string
): Promise<Conversation> {
  const result = await pool.query(
    `INSERT INTO dashboard_agent_conversations (user_id, title, model)
     VALUES ($1, $2, $3)
     RETURNING id, user_id, title, model, created_at, updated_at, last_message_at, pinned_at`,
    [userId, title, model]
  );

  const row = result.rows[0];
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    model: row.model,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    lastMessageAt: row.last_message_at ? new Date(row.last_message_at) : null,
    pinnedAt: row.pinned_at ? new Date(row.pinned_at) : null,
  };
}

/**
 * List conversations for a user, ordered by newest last_message_at first
 */
export async function listConversations(
  pool: pg.Pool,
  userId: string
): Promise<Conversation[]> {
  const result = await pool.query(
    `SELECT id, user_id, title, model, created_at, updated_at, last_message_at, pinned_at
     FROM dashboard_agent_conversations
     WHERE user_id = $1
     ORDER BY pinned_at DESC NULLS LAST, last_message_at DESC NULLS LAST, created_at DESC`,
    [userId]
  );

  return result.rows.map(row => ({
    id: row.id,
    userId: row.user_id,
    title: row.title,
    model: row.model,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    lastMessageAt: row.last_message_at ? new Date(row.last_message_at) : null,
    pinnedAt: row.pinned_at ? new Date(row.pinned_at) : null,
  }));
}

/**
 * Get a conversation by ID, scoped to a user (returns null if user doesn't own it)
 */
export async function getConversation(
  pool: pg.Pool,
  id: string,
  userId: string
): Promise<Conversation | null> {
  const result = await pool.query(
    `SELECT id, user_id, title, model, created_at, updated_at, last_message_at, pinned_at
     FROM dashboard_agent_conversations
     WHERE id = $1 AND user_id = $2`,
    [id, userId]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    model: row.model,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    lastMessageAt: row.last_message_at ? new Date(row.last_message_at) : null,
    pinnedAt: row.pinned_at ? new Date(row.pinned_at) : null,
  };
}

/**
 * Update a conversation's model, scoped to a user. Returns the updated row
 * (or null if the conversation doesn't exist / isn't owned by the caller).
 */
export async function updateConversationModel(
  pool: pg.Pool,
  id: string,
  userId: string,
  model: string
): Promise<Conversation | null> {
  const result = await pool.query(
    `UPDATE dashboard_agent_conversations
        SET model = $3, updated_at = NOW()
      WHERE id = $1 AND user_id = $2
      RETURNING id, user_id, title, model, created_at, updated_at, last_message_at, pinned_at`,
    [id, userId, model]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    model: row.model,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    lastMessageAt: row.last_message_at ? new Date(row.last_message_at) : null,
    pinnedAt: row.pinned_at ? new Date(row.pinned_at) : null,
  };
}

/**
 * Auto-title a conversation after its first assistant turn (Plan 3e Task 2).
 *
 * Guarded server-side (not just by the caller's pre-check) so a race between
 * two turns can't clobber a user-supplied rename: only writes when the title
 * is still the default AND no title has been auto-generated yet. Returns the
 * updated row, or null if the guard didn't match (already titled/renamed) or
 * the conversation doesn't exist / isn't owned by the caller.
 */
export async function updateConversationTitle(
  pool: pg.Pool,
  id: string,
  userId: string,
  title: string
): Promise<Conversation | null> {
  const result = await pool.query(
    `UPDATE dashboard_agent_conversations
        SET title = $3, title_generated_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND user_id = $2
        AND title = 'New conversation'
        AND title_generated_at IS NULL
      RETURNING id, user_id, title, model, created_at, updated_at, last_message_at, pinned_at`,
    [id, userId, title]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    model: row.model,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    lastMessageAt: row.last_message_at ? new Date(row.last_message_at) : null,
    pinnedAt: row.pinned_at ? new Date(row.pinned_at) : null,
  };
}

/**
 * Rename a conversation, scoped to a user. Unlike updateConversationTitle
 * (which only fires the auto-title guard once, before any user rename),
 * this always overwrites the title — the user explicitly chose it. Returns
 * the updated row, or null if the conversation doesn't exist / isn't owned
 * by the caller.
 */
export async function renameConversation(
  pool: pg.Pool,
  id: string,
  userId: string,
  title: string
): Promise<Conversation | null> {
  const result = await pool.query(
    `UPDATE dashboard_agent_conversations
        SET title = $3, updated_at = NOW()
      WHERE id = $1 AND user_id = $2
      RETURNING id, user_id, title, model, created_at, updated_at, last_message_at, pinned_at`,
    [id, userId, title]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    model: row.model,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    lastMessageAt: row.last_message_at ? new Date(row.last_message_at) : null,
    pinnedAt: row.pinned_at ? new Date(row.pinned_at) : null,
  };
}

/**
 * Set or clear a conversation's pin, scoped to a user. Returns the updated
 * row, or null if the conversation doesn't exist / isn't owned by the caller.
 */
export async function pinConversation(
  pool: pg.Pool,
  id: string,
  userId: string,
  pinned: boolean
): Promise<Conversation | null> {
  const result = await pool.query(
    `UPDATE dashboard_agent_conversations
        SET pinned_at = CASE WHEN $3 THEN NOW() ELSE NULL END, updated_at = NOW()
      WHERE id = $1 AND user_id = $2
      RETURNING id, user_id, title, model, created_at, updated_at, last_message_at, pinned_at`,
    [id, userId, pinned]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    model: row.model,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    lastMessageAt: row.last_message_at ? new Date(row.last_message_at) : null,
    pinnedAt: row.pinned_at ? new Date(row.pinned_at) : null,
  };
}

/**
 * Duplicate a conversation, scoped to a user: copies the conversation row
 * (title suffixed with " (copy)", model preserved, pin/auto-title state
 * reset) and every message row into a brand-new conversation. Ownership of
 * the source is enforced the same way as other per-conversation helpers —
 * throws a distinguishable "not found" error the route layer maps to 404.
 */
export async function duplicateConversation(
  pool: pg.Pool,
  id: string,
  userId: string
): Promise<Conversation> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const sourceResult = await client.query(
      `SELECT title, model FROM dashboard_agent_conversations WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );
    if (sourceResult.rows.length === 0) {
      await client.query('ROLLBACK');
      throw new Error('conversation not found');
    }
    const { title, model } = sourceResult.rows[0];

    const newConvResult = await client.query(
      `INSERT INTO dashboard_agent_conversations (user_id, title, model)
       VALUES ($1, $2, $3)
       RETURNING id, user_id, title, model, created_at, updated_at, last_message_at, pinned_at`,
      [userId, `${title} (copy)`, model]
    );
    const newConv = newConvResult.rows[0];

    await client.query(
      `INSERT INTO dashboard_agent_messages
         (conversation_id, role, content, tool_call_id, tool_name, tool_args, tool_result, model_used, created_at)
       SELECT $1, role, content, tool_call_id, tool_name, tool_args, tool_result, model_used, created_at
         FROM dashboard_agent_messages
        WHERE conversation_id = $2
        ORDER BY created_at ASC`,
      [newConv.id, id]
    );

    // Copy last_message_at from the source so the duplicate sorts sensibly
    // (INSERT ... SELECT above doesn't touch it — appendMessage's trigger-like
    // update only runs on the loop's own inserts, not this bulk copy).
    const lastMsg = await client.query(
      `SELECT MAX(created_at) AS last_created_at FROM dashboard_agent_messages WHERE conversation_id = $1`,
      [newConv.id]
    );
    const lastCreatedAt = lastMsg.rows[0]?.last_created_at ?? null;
    if (lastCreatedAt) {
      await client.query(
        `UPDATE dashboard_agent_conversations SET last_message_at = $2 WHERE id = $1`,
        [newConv.id, lastCreatedAt]
      );
    }

    await client.query('COMMIT');

    return {
      id: newConv.id,
      userId: newConv.user_id,
      title: newConv.title,
      model: newConv.model,
      createdAt: new Date(newConv.created_at),
      updatedAt: new Date(newConv.updated_at),
      lastMessageAt: lastCreatedAt ? new Date(lastCreatedAt) : null,
      pinnedAt: newConv.pinned_at ? new Date(newConv.pinned_at) : null,
    };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore — connection may already be rolled back
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Delete a conversation, scoped to a user (messages cascade delete)
 */
export async function deleteConversation(
  pool: pg.Pool,
  id: string,
  userId: string
): Promise<void> {
  await pool.query(
    `DELETE FROM dashboard_agent_conversations
     WHERE id = $1 AND user_id = $2`,
    [id, userId]
  );
}

/**
 * Append a message to a conversation and update its last_message_at
 */
export async function appendMessage(
  pool: pg.Pool,
  conversationId: string,
  msg: Omit<Message, 'id' | 'createdAt' | 'conversationId' | 'modelUsed' | 'pendingApprovalId' | 'rating' | 'ratingReason'> & {
    modelUsed?: string | null;
    pendingApprovalId?: string | null;
  },
  /** Pre-generated id (Plan 3b Task 2): used when the loop needs to know the
   *  row's id before insert, e.g. to reference it from an approval row. */
  id?: string
): Promise<Message> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Insert the message
    const msgResult = await client.query(
      id
        ? `INSERT INTO dashboard_agent_messages
       (id, conversation_id, role, content, tool_call_id, tool_name, tool_args, tool_result, model_used, pending_approval_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id, conversation_id, role, content, tool_call_id, tool_name, tool_args, tool_result, model_used, pending_approval_id, rating, rating_reason, created_at`
        : `INSERT INTO dashboard_agent_messages
       (conversation_id, role, content, tool_call_id, tool_name, tool_args, tool_result, model_used, pending_approval_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, conversation_id, role, content, tool_call_id, tool_name, tool_args, tool_result, model_used, pending_approval_id, rating, rating_reason, created_at`,
      id
        ? [
            id,
            conversationId,
            msg.role,
            msg.content,
            msg.toolCallId,
            msg.toolName,
            msg.toolArgs ? JSON.stringify(msg.toolArgs) : null,
            msg.toolResult ? JSON.stringify(msg.toolResult) : null,
            msg.modelUsed ?? null,
            msg.pendingApprovalId ?? null,
          ]
        : [
            conversationId,
            msg.role,
            msg.content,
            msg.toolCallId,
            msg.toolName,
            msg.toolArgs ? JSON.stringify(msg.toolArgs) : null,
            msg.toolResult ? JSON.stringify(msg.toolResult) : null,
            msg.modelUsed ?? null,
            msg.pendingApprovalId ?? null,
          ]
    );

    const msgRow = msgResult.rows[0];

    // Update the conversation's last_message_at
    await client.query(
      `UPDATE dashboard_agent_conversations
       SET last_message_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [conversationId]
    );

    await client.query('COMMIT');

    return {
      id: msgRow.id,
      conversationId: msgRow.conversation_id,
      role: msgRow.role,
      content: msgRow.content,
      toolCallId: msgRow.tool_call_id,
      toolName: msgRow.tool_name,
      toolArgs: msgRow.tool_args ?? null,
      toolResult: msgRow.tool_result ?? null,
      modelUsed: msgRow.model_used ?? null,
      pendingApprovalId: msgRow.pending_approval_id ?? null,
      rating: msgRow.rating ?? null,
      ratingReason: msgRow.rating_reason ?? null,
      createdAt: new Date(msgRow.created_at),
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Fetch the `tool_args` JSONB payload for the most recent N messages in a
 * conversation (newest first). Used by schema-context.ts to figure out
 * which app_ids the agent has recently touched, without pulling full
 * message rows.
 */
export async function getRecentToolArgs(
  pool: pg.Pool,
  conversationId: string,
  limit = 20
): Promise<Array<unknown | null>> {
  const result = await pool.query(
    `SELECT tool_args
       FROM dashboard_agent_messages
      WHERE conversation_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [conversationId, limit]
  );

  return result.rows.map(row => row.tool_args ?? null);
}

export type SnapshotLabel = {
  snapshotId: string;
  label: string;
  autoGenerated: boolean;
  createdAt: Date;
};

/**
 * List snapshot labels recorded for a (conversation, app) pair. Used by the
 * snapshot-list route to left-join user/auto labels onto the raw
 * manage_repo.list_snapshots history.
 */
export async function listSnapshotLabels(
  pool: pg.Pool,
  conversationId: string,
  appId: string
): Promise<SnapshotLabel[]> {
  const result = await pool.query(
    `SELECT snapshot_id, label, auto_generated, created_at
       FROM dashboard_agent_snapshot_labels
      WHERE conversation_id = $1 AND app_id = $2`,
    [conversationId, appId]
  );

  return result.rows.map(row => ({
    snapshotId: row.snapshot_id,
    label: row.label,
    autoGenerated: row.auto_generated,
    createdAt: new Date(row.created_at),
  }));
}

/**
 * Insert or update the label for a (conversation, app, snapshot) triple.
 * Used by the end-of-turn auto-naming step (Plan 3d Task 5) — if a label
 * already exists for this exact snapshot (e.g. a retry pushed the same
 * snapshot id again), the newer label wins.
 */
export async function upsertSnapshotLabel(
  pool: pg.Pool,
  input: {
    conversationId: string;
    appId: string;
    snapshotId: string;
    label: string;
    autoGenerated: boolean;
  }
): Promise<void> {
  await pool.query(
    `INSERT INTO dashboard_agent_snapshot_labels
       (conversation_id, app_id, snapshot_id, label, auto_generated)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (conversation_id, app_id, snapshot_id)
     DO UPDATE SET label = EXCLUDED.label, auto_generated = EXCLUDED.auto_generated`,
    [input.conversationId, input.appId, input.snapshotId, input.label, input.autoGenerated]
  );
}

/**
 * Find the paused assistant tool-call row gated by a given approval
 * (dashboard_agent_messages.pending_approval_id = approvalId). Used by the
 * resume flow (Plan 3b Task 3) to recover the tool_call_id it must attach
 * the follow-up tool-result row to.
 */
export async function getMessageByPendingApprovalId(
  pool: pg.Pool,
  approvalId: string
): Promise<Message | null> {
  const result = await pool.query(
    `SELECT id, conversation_id, role, content, tool_call_id, tool_name, tool_args, tool_result, model_used, pending_approval_id, rating, rating_reason, created_at
     FROM dashboard_agent_messages
     WHERE pending_approval_id = $1`,
    [approvalId]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    toolArgs: row.tool_args ?? null,
    toolResult: row.tool_result ?? null,
    modelUsed: row.model_used ?? null,
    pendingApprovalId: row.pending_approval_id ?? null,
    rating: row.rating ?? null,
    ratingReason: row.rating_reason ?? null,
    createdAt: new Date(row.created_at),
  };
}

/**
 * ============================================================================
 * KEEP A GATED CONVERSATION'S HISTORY VALID WHILE THE OWNER THINKS.
 * ============================================================================
 *
 * THE INVARIANT, stated exactly. Chat-completions histories are rejected when
 * an assistant `tool_calls` message is not IMMEDIATELY followed by the
 * `role:'tool'` message answering it. Adjacency, not merely existence — and
 * adjacency is a structural property of how this store is written today
 * (loop.ts appends assistant-then-tool per call, resume.ts appends the tool row
 * while the paused assistant row is still last). `trimOperatorHistory` relies
 * on that property; it can drop an unanswered call, it cannot re-pair one.
 *
 * WHAT BROKE IT. Until 2026-08-08 a pending approval skipped the whole wake, so
 * nothing could ever be appended between a paused call and its eventual result.
 * Now the operator keeps working while a decision waits — which would put a
 * turn's worth of messages between the two halves of that pair, and the tool
 * row resume.ts appends on resolution would land non-adjacent. That is the
 * wedge, in a new shape.
 *
 * THE FIX, which is why this function exists: close the pair AT ONCE, while the
 * paused assistant row is still the last message, with a truthful placeholder
 * ("not executed — waiting on the owner"). The pair is never open across
 * appended work. When the owner answers, `replaceToolResultForCall` overwrites
 * that same row IN PLACE (see resume.ts) — no second row, no re-ordering, no
 * change to the approvals data model.
 *
 * BOTH PRECONDITIONS ARE IN THE SQL, not in the caller:
 *   - nothing already answers this tool_call_id (idempotent across wakes, and
 *     safe against a concurrent resolution writing the real result first);
 *   - the paused row is still the LAST message in its conversation, so the row
 *     this inserts is adjacent to it by construction. If it is not last, this
 *     refuses ('not_closable') and the caller falls back to skipping the wake —
 *     never inserting a result in the wrong place.
 *
 * Deliberately does NOT touch `last_message_at`: this is bookkeeping about a
 * turn that already happened, not new conversation activity.
 */
export type CloseGateOutcome = 'closed' | 'already_closed' | 'not_closable';

export async function closeUnansweredToolCall(
  pool: pg.Pool,
  approvalId: string,
  placeholderResult: unknown,
): Promise<CloseGateOutcome> {
  const inserted = await pool.query(
    `INSERT INTO dashboard_agent_messages
       (conversation_id, role, content, tool_call_id, tool_name, tool_args, tool_result)
     SELECT p.conversation_id, 'tool', '', p.tool_call_id, p.tool_name, p.tool_args, $2::jsonb
     FROM dashboard_agent_messages p
     WHERE p.pending_approval_id = $1
       AND p.role = 'assistant'
       AND p.tool_call_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM dashboard_agent_messages t
         WHERE t.conversation_id = p.conversation_id
           AND t.role = 'tool'
           AND t.tool_call_id = p.tool_call_id
       )
       AND NOT EXISTS (
         SELECT 1 FROM dashboard_agent_messages n
         WHERE n.conversation_id = p.conversation_id
           AND n.created_at > p.created_at
       )
     RETURNING id`,
    [approvalId, JSON.stringify(placeholderResult ?? {})],
  );
  if ((inserted.rowCount ?? 0) > 0) return 'closed';

  // Zero rows means one of two very different things. Distinguish them: an
  // already-answered call is the ordinary steady state (every wake after the
  // first), while anything else means the pair is open and cannot be closed
  // adjacently — the caller must NOT run a turn on that history.
  const answered = await pool.query(
    `SELECT 1
     FROM dashboard_agent_messages p
     JOIN dashboard_agent_messages t
       ON t.conversation_id = p.conversation_id
      AND t.role = 'tool'
      AND t.tool_call_id = p.tool_call_id
     WHERE p.pending_approval_id = $1
     LIMIT 1`,
    [approvalId],
  );
  return (answered.rowCount ?? 0) > 0 ? 'already_closed' : 'not_closable';
}

/**
 * Overwrite the `role:'tool'` row answering a given tool_call_id, if one
 * exists. Returns false when there is none, in which case the caller appends
 * as it always did.
 *
 * This is the other half of `closeUnansweredToolCall`: the placeholder that
 * function wrote is a real row in the real position, so the owner's actual
 * decision must REPLACE it rather than append a second answer to the same call.
 * A conversation that never had a placeholder — the human assistant's, and any
 * operator approval raised before 2026-08-08 — matches nothing here and takes
 * the unchanged append path.
 */
export async function replaceToolResultForCall(
  pool: pg.Pool,
  conversationId: string,
  toolCallId: string,
  fields: { toolName: string | null; toolArgs: unknown; toolResult: unknown },
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE dashboard_agent_messages
     SET tool_name = $3, tool_args = $4::jsonb, tool_result = $5::jsonb
     WHERE conversation_id = $1 AND role = 'tool' AND tool_call_id = $2`,
    [
      conversationId,
      toolCallId,
      fields.toolName,
      fields.toolArgs === undefined || fields.toolArgs === null ? null : JSON.stringify(fields.toolArgs),
      JSON.stringify(fields.toolResult ?? {}),
    ],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Clear pending_approval_id on a message row once its approval has been
 * resolved and the follow-up tool-result row has been persisted.
 */
export async function clearPendingApproval(
  pool: pg.Pool,
  messageId: string
): Promise<void> {
  await pool.query(
    `UPDATE dashboard_agent_messages SET pending_approval_id = NULL WHERE id = $1`,
    [messageId]
  );
}

/**
 * Fetch a single message by id, scoped to a conversation (returns null if it
 * doesn't exist or belongs to a different conversation). Used by the
 * regenerate / edit-and-resend route to validate the target message's role
 * before deleting from it.
 */
export async function getMessageById(
  pool: pg.Pool,
  conversationId: string,
  messageId: string
): Promise<Message | null> {
  const result = await pool.query(
    `SELECT id, conversation_id, role, content, tool_call_id, tool_name, tool_args, tool_result, model_used, pending_approval_id, rating, rating_reason, created_at
       FROM dashboard_agent_messages
      WHERE id = $1 AND conversation_id = $2`,
    [messageId, conversationId]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    toolArgs: row.tool_args ?? null,
    toolResult: row.tool_result ?? null,
    modelUsed: row.model_used ?? null,
    pendingApprovalId: row.pending_approval_id ?? null,
    rating: row.rating ?? null,
    ratingReason: row.rating_reason ?? null,
    createdAt: new Date(row.created_at),
  };
}

/**
 * Fetch a single message by id, scoped to the owning USER (not just a
 * specific conversation id the caller already trusts) — joins through
 * dashboard_agent_conversations to check user_id. Used by the rate route
 * (Plan 3e Task 19) so a cross-tenant rate attempt 404s without a separate
 * conversation-ownership lookup.
 */
export async function getMessageWithOwner(
  pool: pg.Pool,
  messageId: string,
  userId: string
): Promise<Message | null> {
  const result = await pool.query(
    `SELECT m.id, m.conversation_id, m.role, m.content, m.tool_call_id, m.tool_name, m.tool_args, m.tool_result, m.model_used, m.pending_approval_id, m.rating, m.rating_reason, m.created_at
       FROM dashboard_agent_messages m
       JOIN dashboard_agent_conversations c ON c.id = m.conversation_id
      WHERE m.id = $1 AND c.user_id = $2`,
    [messageId, userId]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    toolArgs: row.tool_args ?? null,
    toolResult: row.tool_result ?? null,
    modelUsed: row.model_used ?? null,
    pendingApprovalId: row.pending_approval_id ?? null,
    rating: row.rating ?? null,
    ratingReason: row.rating_reason ?? null,
    createdAt: new Date(row.created_at),
  };
}

/**
 * Set or clear a message's rating (Plan 3e Task 19). `rating: 0` (or the
 * caller omitting a reason) clears both `rating` and `rating_reason` — a
 * thumbs-up (rating: 1) never carries a reason, so any reason argument is
 * ignored unless rating === -1.
 */
export async function rateMessage(
  pool: pg.Pool,
  messageId: string,
  rating: 1 | -1 | 0,
  reason?: string
): Promise<void> {
  if (rating === 0) {
    await pool.query(
      `UPDATE dashboard_agent_messages SET rating = NULL, rating_reason = NULL WHERE id = $1`,
      [messageId]
    );
    return;
  }
  await pool.query(
    `UPDATE dashboard_agent_messages SET rating = $2, rating_reason = $3 WHERE id = $1`,
    [messageId, rating, rating === -1 ? (reason ?? null) : null]
  );
}

/**
 * Delete a message and every message at or after it (by created_at, with id
 * as a tiebreaker for same-millisecond inserts) within a conversation. Used
 * by the regenerate / edit-and-resend flow (Plan 3e Task 6): the caller
 * looks up the target row's created_at first, then this deletes it and
 * everything after so the loop can re-run from a clean point.
 *
 * Runs in its own transaction (BEGIN/COMMIT) — the route only ever calls
 * this once per request and doesn't need to compose it with other writes.
 * Returns the number of rows deleted.
 */
export async function deleteMessagesFromInclusive(
  pool: pg.Pool,
  conversationId: string,
  fromMessageId: string
): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const anchor = await client.query(
      `SELECT created_at FROM dashboard_agent_messages WHERE id = $1 AND conversation_id = $2`,
      [fromMessageId, conversationId]
    );
    if (anchor.rows.length === 0) {
      await client.query('ROLLBACK');
      return 0;
    }
    const fromCreatedAt = anchor.rows[0].created_at;

    const result = await client.query(
      `DELETE FROM dashboard_agent_messages
        WHERE conversation_id = $1
          AND (created_at > $2 OR (created_at = $2 AND id >= $3))`,
      [conversationId, fromCreatedAt, fromMessageId]
    );

    // last_message_at may now point at a deleted row — recompute from what's left.
    const remaining = await client.query(
      `SELECT MAX(created_at) AS last_created_at FROM dashboard_agent_messages WHERE conversation_id = $1`,
      [conversationId]
    );
    await client.query(
      `UPDATE dashboard_agent_conversations SET last_message_at = $2, updated_at = NOW() WHERE id = $1`,
      [conversationId, remaining.rows[0]?.last_created_at ?? null]
    );

    await client.query('COMMIT');
    return result.rowCount ?? 0;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore — connection may already be rolled back
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Fetch the most recent 'user'-role message in a conversation, or null if
 * none exists. Used by the regenerate flow to find the turn to replay after
 * deleting an assistant message and everything after it.
 */
export async function getLastUserMessage(
  pool: pg.Pool,
  conversationId: string
): Promise<Message | null> {
  const result = await pool.query(
    `SELECT id, conversation_id, role, content, tool_call_id, tool_name, tool_args, tool_result, model_used, pending_approval_id, rating, rating_reason, created_at
       FROM dashboard_agent_messages
      WHERE conversation_id = $1 AND role = 'user'
      ORDER BY created_at DESC
      LIMIT 1`,
    [conversationId]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    toolArgs: row.tool_args ?? null,
    toolResult: row.tool_result ?? null,
    modelUsed: row.model_used ?? null,
    pendingApprovalId: row.pending_approval_id ?? null,
    rating: row.rating ?? null,
    ratingReason: row.rating_reason ?? null,
    createdAt: new Date(row.created_at),
  };
}

/**
 * List all messages in a conversation, ordered by creation time. Includes
 * `rating`/`rating_reason` (Plan 3e Task 19) so history rehydrate preserves
 * any thumbs up/down the user left on prior assistant turns.
 */
export async function listMessages(
  pool: pg.Pool,
  conversationId: string
): Promise<Message[]> {
  const result = await pool.query(
    `SELECT id, conversation_id, role, content, tool_call_id, tool_name, tool_args, tool_result, model_used, pending_approval_id, rating, rating_reason, created_at
     FROM dashboard_agent_messages
     WHERE conversation_id = $1
     ORDER BY created_at ASC`,
    [conversationId]
  );

  return result.rows.map(row => ({
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    toolArgs: row.tool_args ?? null,
    toolResult: row.tool_result ?? null,
    modelUsed: row.model_used ?? null,
    pendingApprovalId: row.pending_approval_id ?? null,
    rating: row.rating ?? null,
    ratingReason: row.rating_reason ?? null,
    createdAt: new Date(row.created_at),
  }));
}
