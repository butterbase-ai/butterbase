import pg from 'pg';

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
  msg: Omit<Message, 'id' | 'createdAt' | 'conversationId' | 'modelUsed' | 'pendingApprovalId'> & {
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
       RETURNING id, conversation_id, role, content, tool_call_id, tool_name, tool_args, tool_result, model_used, pending_approval_id, created_at`
        : `INSERT INTO dashboard_agent_messages
       (conversation_id, role, content, tool_call_id, tool_name, tool_args, tool_result, model_used, pending_approval_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, conversation_id, role, content, tool_call_id, tool_name, tool_args, tool_result, model_used, pending_approval_id, created_at`,
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
    `SELECT id, conversation_id, role, content, tool_call_id, tool_name, tool_args, tool_result, model_used, pending_approval_id, created_at
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
    createdAt: new Date(row.created_at),
  };
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
    `SELECT id, conversation_id, role, content, tool_call_id, tool_name, tool_args, tool_result, model_used, pending_approval_id, created_at
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
    createdAt: new Date(row.created_at),
  };
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
    `SELECT id, conversation_id, role, content, tool_call_id, tool_name, tool_args, tool_result, model_used, pending_approval_id, created_at
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
    createdAt: new Date(row.created_at),
  };
}

/**
 * List all messages in a conversation, ordered by creation time
 */
export async function listMessages(
  pool: pg.Pool,
  conversationId: string
): Promise<Message[]> {
  const result = await pool.query(
    `SELECT id, conversation_id, role, content, tool_call_id, tool_name, tool_args, tool_result, model_used, pending_approval_id, created_at
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
    createdAt: new Date(row.created_at),
  }));
}
