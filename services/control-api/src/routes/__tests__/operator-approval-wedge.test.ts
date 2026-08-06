/**
 * C2 regression — the permanent per-org operator wedge.
 *
 * When the operator's loop pauses on a gated tool it persists an assistant row
 * carrying a `tool_call_id` with `tool_result: null` and a
 * `pending_approval_id`, and terminates the turn. The AI gateway REJECTS any
 * conversation history that ends with an assistant `tool_calls` message and no
 * matching tool result (see resume.ts's header).
 *
 * `resolveOperatorApproval` used to flip the approval row and stop, on the
 * assumption that "the operator's loop picks the resolution up". It cannot.
 * And because there is exactly ONE operator conversation per org, reused
 * forever, the FIRST resolved gate left that org's operator sending an invalid
 * message sequence on every wake — every ten minutes, permanently, with no
 * rotation and no recovery short of hand-editing the database.
 *
 * These tests assert the property the gateway actually enforces: after a
 * resolution, EVERY assistant row with a tool_call_id has a matching
 * `role: 'tool'` row, and no pending_approval_id is left behind. They fail
 * against the pre-fix implementation on both the approve and the deny path.
 *
 * Only mcp-client is mocked — executeOnce, the advisory lock, the approvals
 * store and the message store all run against the real control-plane DB.
 */

import { describe, it, expect, vi, beforeEach, afterAll, type MockedFunction } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';

vi.mock('../../services/dashboard-agent/mcp-client.js', async () => {
  const actual = await vi.importActual<typeof import('../../services/dashboard-agent/mcp-client.js')>(
    '../../services/dashboard-agent/mcp-client.js',
  );
  return { ...actual, callMcpTool: vi.fn() };
});

import * as mcpClientModule from '../../services/dashboard-agent/mcp-client.js';
import { resolveOperatorApproval } from '../dashboard-agent.js';
import { getOrCreateOperatorConversation } from '../../services/dashboard-agent/operator-store.js';
import { createApproval, getApprovalForOrg } from '../../services/dashboard-agent/approvals-store.js';
import { appendMessage, listMessages, type Message } from '../../services/dashboard-agent/store.js';

const mockCallMcpTool = mcpClientModule.callMcpTool as MockedFunction<typeof mcpClientModule.callMcpTool>;

const ORG = 'org-wedge-test';
const pool = new Pool({ connectionString: process.env.CONTROL_TEST_DATABASE_URL });

beforeEach(async () => {
  vi.clearAllMocks();
  await pool.query(`DELETE FROM dashboard_agent_conversations WHERE organization_id = $1`, [ORG]);
});

afterAll(async () => {
  await pool.query(`DELETE FROM dashboard_agent_conversations WHERE organization_id = $1`, [ORG]);
  await pool.end();
});

/**
 * Reproduce exactly what loop.ts leaves behind when it gates a tool call:
 * a pre-generated message id, an approval referencing it, then the assistant
 * tool-call row carrying pending_approval_id and no result.
 */
async function pauseOnGatedTool(toolArgs: unknown = { action: 'propose', capability: 'delete_entity' }) {
  const conversationId = await getOrCreateOperatorConversation(pool, ORG, 'claude-sonnet-4-5');
  const messageId = randomUUID();
  const toolCallId = `call_${randomUUID().slice(0, 8)}`;

  const approval = await createApproval(pool, {
    conversationId,
    turnMessageId: messageId,
    toolName: 'manage_substrate',
    toolArgs,
    sensitivity: 'destructive',
  });

  await appendMessage(
    pool,
    conversationId,
    {
      role: 'assistant',
      content: 'I need to delete that entity.',
      toolCallId,
      toolName: 'manage_substrate',
      toolArgs,
      toolResult: null,
      modelUsed: 'claude-sonnet-4-5',
      pendingApprovalId: approval.id,
    },
    messageId,
  );

  return { conversationId, approval, toolCallId };
}

/**
 * The gateway's actual precondition, as a predicate over persisted history:
 * every assistant row that carries a tool_call_id must be answered by a
 * `role: 'tool'` row with the same id.
 */
function unansweredToolCalls(messages: Message[]): string[] {
  const answered = new Set(
    messages.filter((m) => m.role === 'tool' && m.toolCallId).map((m) => m.toolCallId as string),
  );
  return messages
    .filter((m) => m.role === 'assistant' && m.toolCallId && !answered.has(m.toolCallId))
    .map((m) => m.toolCallId as string);
}

describe('C2 — resolving an operator approval leaves a VALID conversation history', () => {
  it('approve: writes the matching role:tool row and clears pending_approval_id', async () => {
    const { conversationId, approval, toolCallId } = await pauseOnGatedTool();
    mockCallMcpTool.mockResolvedValue({ ok: true, result: { action_id: 'act_1', status: 'executed' } });

    // Pre-state: the history is invalid — this is the wedge.
    expect(unansweredToolCalls(await listMessages(pool, conversationId))).toEqual([toolCallId]);

    const outcome = await resolveOperatorApproval(pool, {
      approvalId: approval.id,
      orgId: ORG,
      jwt: 'jwt-token',
      resolution: { status: 'approved' },
    });
    expect(outcome).toEqual({ ok: true });

    const messages = await listMessages(pool, conversationId);

    // 1. The history the next wake will replay is valid.
    expect(unansweredToolCalls(messages)).toEqual([]);

    // 2. The tool row carries the executed result under the matching id.
    const toolRow = messages.find((m) => m.role === 'tool')!;
    expect(toolRow).toBeDefined();
    expect(toolRow.toolCallId).toBe(toolCallId);
    expect(toolRow.toolName).toBe('manage_substrate');
    // The tool RESULT, unwrapped from the McpCallResult envelope — the same
    // shape resume.ts persists for the human assistant.
    expect(toolRow.toolResult).toEqual({ action_id: 'act_1', status: 'executed' });

    // 3. No pending marker survives.
    expect(messages.every((m) => m.pendingApprovalId === null)).toBe(true);

    // 4. The approval itself is resolved.
    expect((await getApprovalForOrg(pool, approval.id, ORG))!.status).toBe('approved');

    // 5. The tool actually ran, exactly once.
    expect(mockCallMcpTool).toHaveBeenCalledTimes(1);
  });

  it('deny: ALSO writes the matching role:tool row and clears pending_approval_id', async () => {
    // The deny path is the one that reached the wedge in production: it skipped
    // execution and wrote nothing at all, so the conversation stayed invalid.
    const { conversationId, approval, toolCallId } = await pauseOnGatedTool();

    const outcome = await resolveOperatorApproval(pool, {
      approvalId: approval.id,
      orgId: ORG,
      jwt: 'jwt-token',
      resolution: { status: 'denied', reason: 'not this customer' },
    });
    expect(outcome).toEqual({ ok: true });

    const messages = await listMessages(pool, conversationId);
    expect(unansweredToolCalls(messages)).toEqual([]);

    const toolRow = messages.find((m) => m.role === 'tool')!;
    expect(toolRow.toolCallId).toBe(toolCallId);
    // The denial is a tool RESULT the model has to see, not an absence.
    expect(toolRow.toolResult).toEqual({ ok: false, error: 'User denied. Reason: not this customer' });

    expect(messages.every((m) => m.pendingApprovalId === null)).toBe(true);

    const resolved = (await getApprovalForOrg(pool, approval.id, ORG))!;
    expect(resolved.status).toBe('denied');
    expect(resolved.denyReason).toBe('not this customer');

    // Denial must never execute the tool.
    expect(mockCallMcpTool).not.toHaveBeenCalled();
  });

  it('a failed execution leaves the approval pending and writes NOTHING (retryable, not wedged)', async () => {
    const { conversationId, approval, toolCallId } = await pauseOnGatedTool();
    mockCallMcpTool.mockResolvedValue({ ok: false, error: 'mcp timeout' });

    const outcome = await resolveOperatorApproval(pool, {
      approvalId: approval.id,
      orgId: ORG,
      jwt: 'jwt-token',
      resolution: { status: 'approved' },
    });
    expect(outcome.ok).toBe(false);
    expect((outcome as { code: number }).code).toBe(502);

    // Still pending, still marked, no orphaned tool row: the human can retry.
    expect((await getApprovalForOrg(pool, approval.id, ORG))!.status).toBe('pending');
    const messages = await listMessages(pool, conversationId);
    expect(messages.filter((m) => m.role === 'tool')).toHaveLength(0);
    expect(messages.find((m) => m.toolCallId === toolCallId)!.pendingApprovalId).toBe(approval.id);
  });

  it('a retried approve replays the cached result and fires the tool once', async () => {
    const { conversationId, approval } = await pauseOnGatedTool();
    mockCallMcpTool.mockResolvedValue({ ok: true, result: { action_id: 'act_1' } });

    const first = await resolveOperatorApproval(pool, {
      approvalId: approval.id, orgId: ORG, jwt: 'jwt-token', resolution: { status: 'approved' },
    });
    const second = await resolveOperatorApproval(pool, {
      approvalId: approval.id, orgId: ORG, jwt: 'jwt-token', resolution: { status: 'approved' },
    });

    expect(first).toEqual({ ok: true });
    // Second is refused by the status guard — but the important part is that
    // the tool did not fire twice and the history did not gain a second row.
    expect(second.ok).toBe(false);
    expect(mockCallMcpTool).toHaveBeenCalledTimes(1);
    expect((await listMessages(pool, conversationId)).filter((m) => m.role === 'tool')).toHaveLength(1);
  });

  it('404s (and writes nothing) for an approval outside the caller org', async () => {
    const { conversationId, approval, toolCallId } = await pauseOnGatedTool();

    const outcome = await resolveOperatorApproval(pool, {
      approvalId: approval.id,
      orgId: 'org-somebody-else',
      jwt: 'jwt-token',
      resolution: { status: 'approved' },
    });
    expect(outcome).toEqual({ ok: false, code: 404, error: 'approval not found' });

    const messages = await listMessages(pool, conversationId);
    expect(unansweredToolCalls(messages)).toEqual([toolCallId]);
    expect(mockCallMcpTool).not.toHaveBeenCalled();
  });

  it('the bridge executes as a HUMAN principal, so substrate approve is not blocked', async () => {
    // The operator policy table denies manage_substrate `approve` to the
    // OPERATOR (it could otherwise approve its own gated proposal and forge an
    // approved_by_kind='human' audit row). The approval bridge calls the same
    // action on a person's behalf and must not be caught by that denial.
    const { approval } = await pauseOnGatedTool({ action: 'approve', action_id: 'act_1' });
    mockCallMcpTool.mockResolvedValue({ ok: true, result: { status: 'executed' } });

    const outcome = await resolveOperatorApproval(pool, {
      approvalId: approval.id, orgId: ORG, jwt: 'jwt-token', resolution: { status: 'approved' },
    });

    expect(outcome).toEqual({ ok: true });
    expect(mockCallMcpTool).toHaveBeenCalledTimes(1);
  });

  it('a non-allowlisted tool is still refused, even for a human principal', async () => {
    const conversationId = await getOrCreateOperatorConversation(pool, ORG, 'claude-sonnet-4-5');
    const messageId = randomUUID();
    const approval = await createApproval(pool, {
      conversationId,
      turnMessageId: messageId,
      toolName: 'manage_billing',
      toolArgs: { action: 'refund' },
      sensitivity: 'destructive',
    });
    await appendMessage(
      pool, conversationId,
      {
        role: 'assistant', content: '', toolCallId: 'call_billing',
        toolName: 'manage_billing', toolArgs: { action: 'refund' }, toolResult: null,
        modelUsed: 'claude-sonnet-4-5', pendingApprovalId: approval.id,
      },
      messageId,
    );

    const outcome = await resolveOperatorApproval(pool, {
      approvalId: approval.id, orgId: ORG, jwt: 'jwt-token', resolution: { status: 'approved' },
    });

    expect(outcome.ok).toBe(false);
    expect((outcome as { code: number }).code).toBe(502);
    expect(mockCallMcpTool).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Regression (fix round 1): the wedge was reachable with NO crash at all.
//
// dashboard_agent_messages.tool_result is JSONB and Postgres rejects NUL
// (U+0000) with `unsupported Unicode escape sequence`. tool-bridge.ts strips
// NULs from the row it CACHES but deliberately returns the raw McpCallResult
// to its caller — so a single NUL in a tool result threw inside
// completeApprovalResolution, AFTER the tool had fired and AFTER the approval
// had flipped to 'approved': no role:'tool' row, marker uncleared, 500 to the
// caller, and a retry that 409s on the status guard. Permanent wedge, no crash
// involved. The earlier claim that only a hard crash could reach the gap was
// wrong. Sanitising happens at the persistence boundary, which fixes the human
// assistant's path too (same pre-existing bug).
// ---------------------------------------------------------------------------

describe('C2 — a NUL byte in the tool result cannot wedge the conversation', () => {
  const NUL = String.fromCharCode(0);

  it('persists the tool row, clears the marker, and throws nothing', async () => {
    const { conversationId, approval, toolCallId } = await pauseOnGatedTool();
    mockCallMcpTool.mockResolvedValue({
      ok: true,
      result: { note: `before${NUL}after`, nested: { [`k${NUL}`]: [`v${NUL}`] } },
    });

    // No throw escapes.
    const outcome = await resolveOperatorApproval(pool, {
      approvalId: approval.id,
      orgId: ORG,
      jwt: 'jwt-token',
      resolution: { status: 'approved' },
    });
    expect(outcome).toEqual({ ok: true });

    const messages = await listMessages(pool, conversationId);

    // The history is valid — this is the whole point.
    expect(unansweredToolCalls(messages)).toEqual([]);

    const toolRow = messages.find((m) => m.role === 'tool')!;
    expect(toolRow).toBeDefined();
    expect(toolRow.toolCallId).toBe(toolCallId);
    // Stored with the NULs stripped: those bytes are the only way the persisted
    // result differs from what the tool returned.
    expect(toolRow.toolResult).toEqual({ note: 'beforeafter', nested: { k: ['v'] } });

    expect(messages.every((m) => m.pendingApprovalId === null)).toBe(true);
    expect((await getApprovalForOrg(pool, approval.id, ORG))!.status).toBe('approved');
  });

  it('a NUL in a deny reason is handled the same way', async () => {
    const { conversationId, approval } = await pauseOnGatedTool();

    const outcome = await resolveOperatorApproval(pool, {
      approvalId: approval.id,
      orgId: ORG,
      jwt: 'jwt-token',
      resolution: { status: 'denied', reason: `bad${NUL}reason` },
    });
    expect(outcome).toEqual({ ok: true });

    const messages = await listMessages(pool, conversationId);
    expect(unansweredToolCalls(messages)).toEqual([]);
    expect(messages.find((m) => m.role === 'tool')!.toolResult).toEqual({
      ok: false,
      error: 'User denied. Reason: badreason',
    });
    expect(messages.every((m) => m.pendingApprovalId === null)).toBe(true);
  });
});
