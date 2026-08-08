/**
 * Fix E — resolving a SUBSTRATE-ESCALATED operator approval.
 *
 * Substrate escalates at PROPOSE time as well as by `default_policy`: a
 * principle conflict returns `requires_approval` even on an 'auto' capability.
 * Those proposes dispatch (verdict 'allow'), substrate parks the action in
 * `proposed`, and — before this fix — no dashboard approval existed, so the
 * work stalled where the operator feed could not see it.
 *
 * The loop half (raising the approval, and where the action id comes from) is
 * pinned in services/dashboard-agent/__tests__/loop-operator-escalation.test.ts.
 * THIS file pins the resolution half against the real control-plane DB:
 *
 *   - the approval is visible through the ORG feed;
 *   - APPROVE calls substrate's native approve(action_id) exactly once and
 *     never re-proposes — the propose already happened;
 *   - DENY rejects the parked action, so nothing is left dangling in
 *     substrate's ledger;
 *   - both write the `role:'tool'` row and clear `pending_approval_id` (the
 *     wedge this branch has already had to fix twice);
 *   - and the approval this second writer creates CANNOT carry any call other
 *     than approve-of-that-action-id.
 *
 * That last one is the security property. `principalMayExecute('human', …)`
 * deliberately lifts the operator's substrate ACTION denials on the replay
 * path, which was safe only because the `approval`-verdict branch in loop.ts
 * was the sole writer of operator approval rows. This adds a second writer, so
 * its constraint has to be pinned, not asserted in a comment.
 *
 * Only mcp-client is mocked; the approvals store, the message store, executeOnce
 * and its advisory lock all run for real.
 */

import { describe, it, expect, vi, beforeEach, afterAll, type MockedFunction } from 'vitest';
import { Pool } from 'pg';

vi.mock('../../services/dashboard-agent/mcp-client.js', async () => {
  const actual = await vi.importActual<typeof import('../../services/dashboard-agent/mcp-client.js')>(
    '../../services/dashboard-agent/mcp-client.js',
  );
  return { ...actual, callMcpTool: vi.fn() };
});

import * as mcpClientModule from '../../services/dashboard-agent/mcp-client.js';
import { resolveOperatorApproval } from '../dashboard-agent.js';
import { getOrCreateOperatorConversation } from '../../services/dashboard-agent/operator-store.js';
import {
  createSubstrateEscalationApproval,
  getApprovalForOrg,
  listPendingByOrg,
} from '../../services/dashboard-agent/approvals-store.js';
import { appendMessage, listMessages, type Message } from '../../services/dashboard-agent/store.js';

const mockCallMcpTool = mcpClientModule.callMcpTool as MockedFunction<typeof mcpClientModule.callMcpTool>;

const ORG = 'org-escalation-test';
const ACTION_ID = 'act_01HZX9ESCALATED';
const USER = 'cognito-sub-approver';

const pool = new Pool({ connectionString: process.env.CONTROL_TEST_DATABASE_URL });

beforeEach(async () => {
  vi.clearAllMocks();
  await pool.query(`DELETE FROM dashboard_agent_conversations WHERE organization_id = $1`, [ORG]);
});

afterAll(async () => {
  await pool.query(`DELETE FROM dashboard_agent_conversations WHERE organization_id = $1`, [ORG]);
  await pool.end();
});

function mcpEnvelope(payload: unknown, isError = false) {
  return { ok: true, result: { isError, content: [{ type: 'text', text: JSON.stringify(payload) }] } };
}

/**
 * Reproduce exactly what loop.ts leaves behind on a POST-dispatch escalation:
 * the assistant tool-call row for the PROPOSE is already persisted (the call
 * went out), and the escalation writer then marks it and creates the approval.
 */
async function escalate(actionId = ACTION_ID) {
  const conversationId = await getOrCreateOperatorConversation(pool, ORG, 'claude-sonnet-4-5');
  const toolCallId = 'call_propose_1';
  const proposeArgs = { action: 'propose', capability: 'record_decision', payload: { note: 'x' } };

  const assistant = await appendMessage(pool, conversationId, {
    role: 'assistant',
    content: 'Recording that decision.',
    toolCallId,
    toolName: 'manage_substrate',
    toolArgs: proposeArgs,
    toolResult: null,
    modelUsed: 'claude-sonnet-4-5',
  });

  const approval = await createSubstrateEscalationApproval(pool, {
    conversationId,
    pausedMessageId: assistant.id,
    actionId,
  });

  return { conversationId, toolCallId, assistantId: assistant.id, approval };
}

function unansweredToolCalls(messages: Message[]): string[] {
  const answered = new Set(
    messages.filter((m) => m.role === 'tool' && m.toolCallId).map((m) => m.toolCallId as string),
  );
  return messages
    .filter((m) => m.role === 'assistant' && m.toolCallId && !answered.has(m.toolCallId))
    .map((m) => m.toolCallId as string);
}

// ---------------------------------------------------------------------------
// The second writer's constraint. THIS is the security test.
// ---------------------------------------------------------------------------

describe('fix E — the escalation approval can only ever carry approve-of-that-action-id', () => {
  it('stores exactly { action: "approve", action_id } — nothing else, from nothing else', async () => {
    const { approval } = await escalate();
    expect(approval).not.toBeNull();

    expect(approval!.toolName).toBe('manage_substrate');
    // Exhaustive, not a subset check: an extra key is the whole failure mode.
    expect(approval!.toolArgs).toEqual({ action: 'approve', action_id: ACTION_ID });
    expect(Object.keys(approval!.toolArgs as object).sort()).toEqual(['action', 'action_id']);
  });

  it('ignores any attempt to supply a tool name, other args, or an org_id', async () => {
    // The function takes no such parameters — this is the runtime half of that
    // claim. If a future refactor added a passthrough, this fails.
    const conversationId = await getOrCreateOperatorConversation(pool, ORG, 'claude-sonnet-4-5');
    const assistant = await appendMessage(pool, conversationId, {
      role: 'assistant',
      content: '',
      toolCallId: 'call_1',
      toolName: 'manage_substrate',
      toolArgs: { action: 'propose' },
      toolResult: null,
      modelUsed: 'claude-sonnet-4-5',
    });

    const approval = await createSubstrateEscalationApproval(pool, {
      conversationId,
      pausedMessageId: assistant.id,
      actionId: ACTION_ID,
      // Everything an attacker would want to smuggle in.
      toolName: 'manage_billing',
      toolArgs: { action: 'set_yolo', enabled: true },
      action: 'set_yolo',
      org_id: 'some-other-org',
      sensitivity: 'confirm',
    } as never);

    expect(approval!.toolName).toBe('manage_substrate');
    expect(approval!.toolArgs).toEqual({ action: 'approve', action_id: ACTION_ID });
    expect(approval!.sensitivity).toBe('destructive');
  });

  it.each([
    ['an object', { action: 'set_yolo' }],
    ['an array', ['act_1']],
    ['a number', 7],
    ['null', null],
    ['undefined', undefined],
    ['an empty string', ''],
    ['whitespace/newline injection', 'act_1\n{"action":"set_yolo"}'],
    ['a quote-bearing string', 'act_1","action":"set_yolo'],
    ['an over-long blob', 'a'.repeat(200)],
  ])('refuses to create an approval when the action id is %s', async (_label, actionId) => {
    const conversationId = await getOrCreateOperatorConversation(pool, ORG, 'claude-sonnet-4-5');
    const assistant = await appendMessage(pool, conversationId, {
      role: 'assistant',
      content: '',
      toolCallId: 'call_1',
      toolName: 'manage_substrate',
      toolArgs: { action: 'propose' },
      toolResult: null,
      modelUsed: 'claude-sonnet-4-5',
    });

    const approval = await createSubstrateEscalationApproval(pool, {
      conversationId,
      pausedMessageId: assistant.id,
      actionId: actionId as never,
    });

    expect(approval).toBeNull();
    // And nothing was written: no pending row to block the operator, no marker.
    expect(await listPendingByOrg(pool, ORG)).toEqual([]);
    const messages = await listMessages(pool, conversationId);
    expect(messages.every((m) => m.pendingApprovalId === null)).toBe(true);
  });

  it('is atomic: a target row it cannot mark leaves no approval behind', async () => {
    // An approval row without its pending_approval_id marker would be BOTH
    // unresolvable (completeApprovalResolution 400s) and blocking
    // (runOperatorTurn refuses to wake while one is pending) — a wedge in both
    // directions. The two writes are one transaction.
    const conversationId = await getOrCreateOperatorConversation(pool, ORG, 'claude-sonnet-4-5');

    const approval = await createSubstrateEscalationApproval(pool, {
      conversationId,
      pausedMessageId: '00000000-0000-4000-8000-000000000000',
      actionId: ACTION_ID,
    });

    expect(approval).toBeNull();
    expect(await listPendingByOrg(pool, ORG)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Visibility + resolution
// ---------------------------------------------------------------------------

describe('fix E — the escalated approval reaches the operator feed and resolves', () => {
  it('is visible through the org feed', async () => {
    const { approval } = await escalate();

    const feed = await listPendingByOrg(pool, ORG);
    expect(feed.map((a) => a.id)).toEqual([approval!.id]);
    expect(feed[0].toolArgs).toEqual({ action: 'approve', action_id: ACTION_ID });
  });

  it('approve: calls substrate approve ONCE, never re-proposes, and completes the history', async () => {
    const { conversationId, toolCallId, approval } = await escalate();
    mockCallMcpTool.mockResolvedValue(mcpEnvelope({ action_id: ACTION_ID, status: 'executed' }) as never);

    // Pre-state: the history is invalid until the resolution answers the call.
    expect(unansweredToolCalls(await listMessages(pool, conversationId))).toEqual([toolCallId]);

    const outcome = await resolveOperatorApproval(pool, {
      approvalId: approval!.id,
      orgId: ORG,
      jwt: 'jwt-token',
      userId: USER,
      resolution: { status: 'approved' },
    });
    expect(outcome).toEqual({ ok: true });

    // THE point of this fix's shape: one call, and it is the APPROVE.
    expect(mockCallMcpTool).toHaveBeenCalledTimes(1);
    const [name, args] = mockCallMcpTool.mock.calls[0];
    expect(name).toBe('manage_substrate');
    expect(args).toEqual({ action: 'approve', action_id: ACTION_ID });
    // Explicitly: no second propose. The action already exists.
    expect(
      mockCallMcpTool.mock.calls.some((c) => (c[1] as { action?: string } | undefined)?.action === 'propose'),
    ).toBe(false);

    const messages = await listMessages(pool, conversationId);
    expect(unansweredToolCalls(messages)).toEqual([]);
    const toolRow = messages.find((m) => m.role === 'tool')!;
    expect(toolRow.toolCallId).toBe(toolCallId);
    // The MCP envelope, as resume.ts persists it for every other approval kind.
    expect(toolRow.toolResult).toEqual({
      isError: false,
      content: [{ type: 'text', text: JSON.stringify({ action_id: ACTION_ID, status: 'executed' }) }],
    });
    expect(messages.every((m) => m.pendingApprovalId === null)).toBe(true);

    const resolved = (await getApprovalForOrg(pool, approval!.id, ORG))!;
    expect(resolved.status).toBe('approved');
    expect(resolved.resolvedBy).toBe(USER);
  });

  it('deny: REJECTS the parked substrate action, so nothing is left dangling', async () => {
    const { conversationId, toolCallId, approval } = await escalate();
    mockCallMcpTool.mockResolvedValue(mcpEnvelope({ action_id: ACTION_ID, status: 'rejected' }) as never);

    const outcome = await resolveOperatorApproval(pool, {
      approvalId: approval!.id,
      orgId: ORG,
      jwt: 'jwt-token',
      userId: USER,
      resolution: { status: 'denied', reason: 'conflicts with our refund principle' },
    });
    expect(outcome).toEqual({ ok: true });

    expect(mockCallMcpTool).toHaveBeenCalledTimes(1);
    const [name, args] = mockCallMcpTool.mock.calls[0];
    expect(name).toBe('manage_substrate');
    expect(args).toEqual({
      action: 'reject',
      action_id: ACTION_ID,
      reason: 'conflicts with our refund principle',
    });

    const messages = await listMessages(pool, conversationId);
    expect(unansweredToolCalls(messages)).toEqual([]);
    const toolRow = messages.find((m) => m.role === 'tool')!;
    expect(toolRow.toolCallId).toBe(toolCallId);
    expect(toolRow.toolResult).toEqual({
      ok: false,
      error: 'User denied. Reason: conflicts with our refund principle',
      substrate_action_rejected: true,
    });
    expect(messages.every((m) => m.pendingApprovalId === null)).toBe(true);
    expect((await getApprovalForOrg(pool, approval!.id, ORG))!.status).toBe('denied');
  });

  it('deny: a FAILED substrate reject still closes the approval, and says so', async () => {
    // An approval a human cannot deny wedges the org's one operator
    // conversation. That is strictly worse than a stale `proposed` row, so the
    // reject is best-effort — but the residue is recorded, not swallowed.
    const { conversationId, approval } = await escalate();
    mockCallMcpTool.mockResolvedValue({ ok: false, error: 'substrate unreachable' } as never);

    const outcome = await resolveOperatorApproval(pool, {
      approvalId: approval!.id,
      orgId: ORG,
      jwt: 'jwt-token',
      userId: USER,
      resolution: { status: 'denied' },
    });
    expect(outcome).toEqual({ ok: true });

    const messages = await listMessages(pool, conversationId);
    expect(unansweredToolCalls(messages)).toEqual([]);
    expect(messages.find((m) => m.role === 'tool')!.toolResult).toEqual({
      ok: false,
      error: 'User denied.',
      substrate_action_rejected: false,
      substrate_reject_error: 'substrate unreachable',
    });
    expect(messages.every((m) => m.pendingApprovalId === null)).toBe(true);
    expect((await getApprovalForOrg(pool, approval!.id, ORG))!.status).toBe('denied');
  });

  it('deny on a PRE-EMPTED approval still calls nothing — there is no parked action', async () => {
    // The pre-dispatch gate pauses before substrate ever sees the propose, so
    // denyCleanup must be a no-op there. Guards against the reject firing on
    // approvals whose stored call is a propose or a rule mutation.
    const conversationId = await getOrCreateOperatorConversation(pool, ORG, 'claude-sonnet-4-5');
    const { createApproval } = await import('../../services/dashboard-agent/approvals-store.js');
    const { randomUUID } = await import('crypto');
    const messageId = randomUUID();
    const proposeArgs = { action: 'propose', capability: 'delete_entity' };
    const approval = await createApproval(pool, {
      conversationId,
      turnMessageId: messageId,
      toolName: 'manage_substrate',
      toolArgs: proposeArgs,
      sensitivity: 'destructive',
    });
    await appendMessage(
      pool,
      conversationId,
      {
        role: 'assistant',
        content: '',
        toolCallId: 'call_preempt',
        toolName: 'manage_substrate',
        toolArgs: proposeArgs,
        toolResult: null,
        modelUsed: 'claude-sonnet-4-5',
        pendingApprovalId: approval.id,
      },
      messageId,
    );

    const outcome = await resolveOperatorApproval(pool, {
      approvalId: approval.id,
      orgId: ORG,
      jwt: 'jwt-token',
      userId: USER,
      resolution: { status: 'denied', reason: 'no' },
    });
    expect(outcome).toEqual({ ok: true });

    expect(mockCallMcpTool).not.toHaveBeenCalled();
    const messages = await listMessages(pool, conversationId);
    expect(messages.find((m) => m.role === 'tool')!.toolResult).toEqual({
      ok: false,
      error: 'User denied. Reason: no',
    });
  });

  it('a retried approve does not fire substrate approve twice', async () => {
    const { approval } = await escalate();
    mockCallMcpTool.mockResolvedValue(mcpEnvelope({ status: 'executed' }) as never);

    const first = await resolveOperatorApproval(pool, {
      approvalId: approval!.id, orgId: ORG, jwt: 'jwt', userId: USER, resolution: { status: 'approved' },
    });
    const second = await resolveOperatorApproval(pool, {
      approvalId: approval!.id, orgId: ORG, jwt: 'jwt', userId: USER, resolution: { status: 'approved' },
    });

    expect(first).toEqual({ ok: true });
    expect(second.ok).toBe(false);
    expect(mockCallMcpTool).toHaveBeenCalledTimes(1);
  });
});
