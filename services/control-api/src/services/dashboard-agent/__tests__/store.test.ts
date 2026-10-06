import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import {
  createConversation,
  listConversations,
  getConversation,
  deleteConversation,
  appendMessage,
  listMessages,
  type Conversation,
  type Message,
} from '../store.js';

describe('Dashboard Agent Store', () => {
  let pool: pg.Pool;
  let testUserId: string;
  let otherUserId: string;

  beforeAll(async () => {
    // Create a direct pool connection for testing
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL || 'postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control',
      max: 10,
    });

    // Use unique emails to avoid collisions in tests that rerun
    const timestamp = Date.now();
    const email1 = `store-test-user-${timestamp}-1@example.com`;
    const email2 = `store-test-user-${timestamp}-2@example.com`;

    // Create test users with personal organizations
    // First user
    const org1Result = await pool.query(
      `INSERT INTO organizations (name, owner_id, personal)
       VALUES (gen_random_uuid()::text, gen_random_uuid(), true)
       RETURNING id`
    );
    const org1Id = org1Result.rows[0].id;

    const user1Result = await pool.query(
      `INSERT INTO platform_users (email, cognito_sub, personal_organization_id)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [email1, `store-test-sub-${timestamp}-1`, org1Id]
    );
    testUserId = user1Result.rows[0].id;

    // Update organization owner to the user
    await pool.query(
      `UPDATE organizations SET owner_id = $1 WHERE id = $2`,
      [testUserId, org1Id]
    );

    // Second user
    const org2Result = await pool.query(
      `INSERT INTO organizations (name, owner_id, personal)
       VALUES (gen_random_uuid()::text, gen_random_uuid(), true)
       RETURNING id`
    );
    const org2Id = org2Result.rows[0].id;

    const user2Result = await pool.query(
      `INSERT INTO platform_users (email, cognito_sub, personal_organization_id)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [email2, `store-test-sub-${timestamp}-2`, org2Id]
    );
    otherUserId = user2Result.rows[0].id;

    // Update organization owner to the user
    await pool.query(
      `UPDATE organizations SET owner_id = $1 WHERE id = $2`,
      [otherUserId, org2Id]
    );
  });

  afterAll(async () => {
    // Clean up test data - order matters due to foreign keys
    await pool.query(
      'DELETE FROM dashboard_agent_messages WHERE conversation_id IN (SELECT id FROM dashboard_agent_conversations WHERE user_id IN ($1, $2))',
      [testUserId, otherUserId]
    );
    await pool.query(
      'DELETE FROM dashboard_agent_conversations WHERE user_id IN ($1, $2)',
      [testUserId, otherUserId]
    );
    // Delete organization memberships (but we created them as personal orgs so this may be empty)
    await pool.query(
      `DELETE FROM organization_members WHERE user_id IN ($1, $2)`,
      [testUserId, otherUserId]
    );
    // Delete the platform users first (before deleting organizations they own)
    await pool.query(
      'DELETE FROM platform_users WHERE id IN ($1, $2)',
      [testUserId, otherUserId]
    );
    // Now delete the organizations (they have ON DELETE CASCADE)
    await pool.query(
      `DELETE FROM organizations WHERE owner_id IS NULL`
    );
    await pool.end();
  });

  it('createConversation returns a row with the given user + title + model', async () => {
    const result = await createConversation(pool, testUserId, 'Test Conv', 'gpt-4');

    expect(result.id).toBeDefined();
    expect(result.userId).toBe(testUserId);
    expect(result.title).toBe('Test Conv');
    expect(result.model).toBe('gpt-4');
    expect(result.createdAt).toBeInstanceOf(Date);
    expect(result.updatedAt).toBeInstanceOf(Date);
    expect(result.lastMessageAt).toBeNull();
  });

  it('listConversations returns only rows for that user, newest last_message_at first', async () => {
    // Create conversations for testUserId
    const conv1 = await createConversation(pool, testUserId, 'Conv 1 - List Test', 'gpt-4');
    const conv2 = await createConversation(pool, testUserId, 'Conv 2 - List Test', 'gpt-3.5-turbo');

    // Create a conversation for otherUserId
    await createConversation(pool, otherUserId, 'Other Conv', 'gpt-4');

    // Add messages to conv1 and conv2 so they have different last_message_at
    await appendMessage(pool, conv1.id, {
      role: 'user',
      content: 'Hello',
      toolCallId: null,
      toolName: null,
      toolArgs: null,
      toolResult: null,
    });

    // Wait a bit to ensure different timestamps
    await new Promise(resolve => setTimeout(resolve, 10));

    await appendMessage(pool, conv2.id, {
      role: 'assistant',
      content: 'Hi',
      toolCallId: null,
      toolName: null,
      toolArgs: null,
      toolResult: null,
    });

    const result = await listConversations(pool, testUserId);

    // Filter to only the conversations we just created for this test
    const testConvs = result.filter(c => c.title.includes('List Test'));
    expect(testConvs.length).toBe(2);
    // Conv2 should be first because it has the newer last_message_at
    expect(testConvs[0].id).toBe(conv2.id);
    expect(testConvs[1].id).toBe(conv1.id);
    // Verify no conversations from other user in result
    expect(result.every(c => c.userId === testUserId)).toBe(true);
  });

  it('appendMessage sets last_message_at on the conversation', async () => {
    const conv = await createConversation(pool, testUserId, 'Message Test', 'gpt-4');

    const before = Date.now() - 1000; // Give 1 second buffer for DB time differences
    const msg = await appendMessage(pool, conv.id, {
      role: 'user',
      content: 'Test message',
      toolCallId: null,
      toolName: null,
      toolArgs: null,
      toolResult: null,
    });
    const after = Date.now() + 1000; // Give 1 second buffer for DB time differences

    expect(msg.id).toBeDefined();
    expect(msg.conversationId).toBe(conv.id);
    expect(msg.role).toBe('user');
    expect(msg.content).toBe('Test message');

    // Verify conversation's last_message_at was updated
    const updated = await getConversation(pool, conv.id, testUserId);
    expect(updated).not.toBeNull();
    expect(updated!.lastMessageAt).not.toBeNull();
    expect(updated!.lastMessageAt!.getTime()).toBeGreaterThanOrEqual(before);
    expect(updated!.lastMessageAt!.getTime()).toBeLessThanOrEqual(after);
  });

  it('getConversation returns null if userId does not match (user isolation)', async () => {
    const conv = await createConversation(pool, testUserId, 'Isolation Test', 'gpt-4');

    // Try to get the conversation with a different user ID
    const result = await getConversation(pool, conv.id, otherUserId);

    expect(result).toBeNull();
  });

  it('deleteConversation cascades to messages', async () => {
    const conv = await createConversation(pool, testUserId, 'Delete Test', 'gpt-4');

    await appendMessage(pool, conv.id, {
      role: 'user',
      content: 'Message 1',
      toolCallId: null,
      toolName: null,
      toolArgs: null,
      toolResult: null,
    });

    await appendMessage(pool, conv.id, {
      role: 'assistant',
      content: 'Message 2',
      toolCallId: null,
      toolName: null,
      toolArgs: null,
      toolResult: null,
    });

    // Verify messages exist
    let messages = await listMessages(pool, conv.id);
    expect(messages.length).toBe(2);

    // Delete the conversation
    await deleteConversation(pool, conv.id, testUserId);

    // Verify conversation is deleted
    const deleted = await getConversation(pool, conv.id, testUserId);
    expect(deleted).toBeNull();

    // Verify messages are cascaded deleted
    messages = await listMessages(pool, conv.id);
    expect(messages.length).toBe(0);
  });

  it('appendMessage and listMessages preserve tool args and result as objects (JSONB)', async () => {
    const conv = await createConversation(pool, testUserId, 'Tool Test', 'gpt-4');

    const toolArgs = { action: 'list', filter: { status: 'active' } };
    const toolResult = { apps: [{ id: 'app_x', name: 'App X' }], count: 1 };

    // Append a tool message with non-null args and result
    const appended = await appendMessage(pool, conv.id, {
      role: 'tool',
      content: 'Tool output',
      toolCallId: 'call_123',
      toolName: 'list_apps',
      toolArgs,
      toolResult,
    });

    // Verify appendMessage returns the objects as-is (not stringified)
    expect(appended.toolCallId).toBe('call_123');
    expect(appended.toolName).toBe('list_apps');
    expect(appended.toolArgs).toEqual(toolArgs);
    expect(appended.toolResult).toEqual(toolResult);

    // Verify listMessages returns the same objects intact
    const messages = await listMessages(pool, conv.id);
    expect(messages.length).toBe(1);
    const retrieved = messages[0];
    expect(retrieved.toolArgs).toEqual(toolArgs);
    expect(retrieved.toolResult).toEqual(toolResult);
  });
});
