import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import pg from 'pg';

// resolveOperatorApproval's execute path goes through executeApprovedOperatorTool
// (substrate-approval-bridge.ts), which makes a real MCP/substrate call. Mock it
// so this test exercises only the resolution bookkeeping — approval row,
// resolved_by, the follow-up tool row — not the tool dispatch itself.
vi.mock('../../services/dashboard-agent/substrate-approval-bridge.js', () => ({
  executeApprovedOperatorTool: vi.fn(async () => ({ ok: true, result: { ok: true } })),
}));

import { resolveOperatorApproval } from '../dashboard-agent.js';
import { operatorUserId } from '../../services/dashboard-agent/operator-store.js';
import { createApproval, getApprovalForOrg } from '../../services/dashboard-agent/approvals-store.js';
import { appendMessage } from '../../services/dashboard-agent/store.js';

const pool = new pg.Pool({ connectionString: process.env.CONTROL_TEST_DATABASE_URL });
const ORG = 'org-test-resolved-by';
const RESOLVER_USER_ID = 'resolver-user-1';

async function seedPausedOperatorApproval(toolName: string) {
  const userId = operatorUserId(ORG);
  const conv = await pool.query(
    `INSERT INTO dashboard_agent_conversations (organization_id, user_id, title, model)
     VALUES ($1, $2, 'Operator', 'claude-sonnet-4-5')
     RETURNING id`,
    [ORG, userId],
  );
  const conversationId = conv.rows[0].id;

  // Assistant row carrying the pending tool call, matching what loop.ts
  // writes when it pauses a turn on a gated tool.
  const assistantMsg = await appendMessage(pool, conversationId, {
    role: 'assistant',
    content: '',
    toolCallId: 'call-1',
    toolName,
    toolArgs: { orgId: ORG },
    toolResult: null,
  });

  const approval = await createApproval(pool, {
    conversationId,
    turnMessageId: assistantMsg.id,
    toolName,
    toolArgs: { orgId: ORG },
    sensitivity: 'destructive',
  });

  await pool.query(
    `UPDATE dashboard_agent_messages SET pending_approval_id = $1 WHERE id = $2`,
    [approval.id, assistantMsg.id],
  );

  return { conversationId, approval };
}

beforeEach(async () => {
  vi.clearAllMocks();
  await pool.query(
    `DELETE FROM dashboard_agent_conversations WHERE organization_id = $1`,
    [ORG],
  );
});
afterAll(async () => {
  await pool.end();
});

describe('resolveOperatorApproval — resolved_by', () => {
  it('records the resolving user id when approved', async () => {
    const { approval } = await seedPausedOperatorApproval('manage_substrate');

    const outcome = await resolveOperatorApproval(pool, {
      approvalId: approval.id,
      orgId: ORG,
      jwt: 'test-jwt',
      userId: RESOLVER_USER_ID,
      resolution: { status: 'approved' },
    });

    expect(outcome.ok).toBe(true);
    const resolved = await getApprovalForOrg(pool, approval.id, ORG);
    expect(resolved?.status).toBe('approved');
    expect(resolved?.resolvedBy).toBe(RESOLVER_USER_ID);
  });

  it('records the resolving user id when denied', async () => {
    const { approval } = await seedPausedOperatorApproval('manage_substrate');

    const outcome = await resolveOperatorApproval(pool, {
      approvalId: approval.id,
      orgId: ORG,
      jwt: 'test-jwt',
      userId: RESOLVER_USER_ID,
      resolution: { status: 'denied', reason: 'not now' },
    });

    expect(outcome.ok).toBe(true);
    const resolved = await getApprovalForOrg(pool, approval.id, ORG);
    expect(resolved?.status).toBe('denied');
    expect(resolved?.resolvedBy).toBe(RESOLVER_USER_ID);
  });
});
