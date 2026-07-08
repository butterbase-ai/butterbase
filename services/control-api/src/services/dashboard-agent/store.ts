import pg from 'pg';

export type Conversation = {
  id: string;
  userId: string;
  title: string;
  model: string;
  createdAt: Date;
  updatedAt: Date;
  lastMessageAt: Date | null;
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
     RETURNING id, user_id, title, model, created_at, updated_at, last_message_at`,
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
    `SELECT id, user_id, title, model, created_at, updated_at, last_message_at
     FROM dashboard_agent_conversations
     WHERE user_id = $1
     ORDER BY last_message_at DESC NULLS LAST, created_at DESC`,
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
    `SELECT id, user_id, title, model, created_at, updated_at, last_message_at
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
      RETURNING id, user_id, title, model, created_at, updated_at, last_message_at`,
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
  };
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
  msg: Omit<Message, 'id' | 'createdAt' | 'conversationId' | 'modelUsed'> & { modelUsed?: string | null }
): Promise<Message> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Insert the message
    const msgResult = await client.query(
      `INSERT INTO dashboard_agent_messages
       (conversation_id, role, content, tool_call_id, tool_name, tool_args, tool_result, model_used)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, conversation_id, role, content, tool_call_id, tool_name, tool_args, tool_result, model_used, created_at`,
      [
        conversationId,
        msg.role,
        msg.content,
        msg.toolCallId,
        msg.toolName,
        msg.toolArgs ? JSON.stringify(msg.toolArgs) : null,
        msg.toolResult ? JSON.stringify(msg.toolResult) : null,
        msg.modelUsed ?? null,
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
 * List all messages in a conversation, ordered by creation time
 */
export async function listMessages(
  pool: pg.Pool,
  conversationId: string
): Promise<Message[]> {
  const result = await pool.query(
    `SELECT id, conversation_id, role, content, tool_call_id, tool_name, tool_args, tool_result, model_used, created_at
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
    createdAt: new Date(row.created_at),
  }));
}
