import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import pg from 'pg';

vi.mock('../mcp-client.js', () => ({
  callMcpTool: vi.fn(async () => ({ ok: true, result: { ok: true } })),
}));

import { resolveApprovalAndPersistResult } from '../resume.js';
import { createApproval, getApproval } from '../approvals-store.js';
import { appendMessage, createConversation } from '../store.js';

const pool = new pg.Pool({ connectionString: process.env.CONTROL_TEST_DATABASE_URL });
const RESOLVER_USER_ID = 'human-resolver-1';

async function seedPausedApproval(toolName: string) {
  const conversation = await createConversation(pool, RESOLVER_USER_ID, 'Test', 'claude-sonnet-4-5');

  const assistantMsg = await appendMessage(pool, conversation.id, {
    role: 'assistant',
    content: '',
    toolCallId: 'call-1',
    toolName,
    toolArgs: { appId: 'app-1' },
    toolResult: null,
  });

  const approval = await createApproval(pool, {
    conversationId: conversation.id,
    turnMessageId: assistantMsg.id,
    toolName,
    toolArgs: { appId: 'app-1' },
    sensitivity: 'destructive',
  });

  await pool.query(
    `UPDATE dashboard_agent_messages SET pending_approval_id = $1 WHERE id = $2`,
    [approval.id, assistantMsg.id],
  );

  return { conversation, approval };
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterAll(async () => {
  await pool.end();
});

describe('resolveApprovalAndPersistResult — resolved_by', () => {
  it('records the resolving user id when approved', async () => {
    const { approval } = await seedPausedApproval('deploy_app');

    const outcome = await resolveApprovalAndPersistResult(pool, {
      approvalId: approval.id,
      userId: RESOLVER_USER_ID,
      jwt: 'test-jwt',
      resolution: { status: 'approved' },
    });

    expect(outcome.ok).toBe(true);
    const resolved = await getApproval(pool, approval.id, RESOLVER_USER_ID);
    expect(resolved?.status).toBe('approved');
    expect(resolved?.resolvedBy).toBe(RESOLVER_USER_ID);
  });

  it('records the resolving user id when denied', async () => {
    const { approval } = await seedPausedApproval('delete_app');

    const outcome = await resolveApprovalAndPersistResult(pool, {
      approvalId: approval.id,
      userId: RESOLVER_USER_ID,
      jwt: 'test-jwt',
      resolution: { status: 'denied', reason: 'no' },
    });

    expect(outcome.ok).toBe(true);
    const resolved = await getApproval(pool, approval.id, RESOLVER_USER_ID);
    expect(resolved?.status).toBe('denied');
    expect(resolved?.resolvedBy).toBe(RESOLVER_USER_ID);
  });
});
