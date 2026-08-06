/**
 * C2b regression — the substrate approval bridge.
 *
 * Before the bridge, approving a gated substrate propose in the operator feed
 * produced a SECOND approval instead of an execution: `resolveOperatorApproval`
 * replayed the original `propose`, substrate applied its own policy engine,
 * and returned `{ action_id, requires_approval: true }` with the action left
 * in `proposed`. Nothing executed, and the turn resumed with "pending" as its
 * tool result. The human had approved at our layer and was expected to approve
 * again at substrate's.
 *
 * These tests pin the bridged behaviour end to end through
 * `resolveOperatorApproval` against the real control-plane database — the
 * approvals store, the advisory-lock execution ledger and the message store
 * are all real; only `callMcpTool` is mocked, standing in for substrate.
 *
 * They also pin the thing the bridge must NOT be mistaken for: permission for
 * the operator to approve. `approve` stays denied to principal 'operator'.
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
import { executeOnce } from '../../services/dashboard-agent/tool-bridge.js';
import { getOrCreateOperatorConversation } from '../../services/dashboard-agent/operator-store.js';
import { createApproval, getApprovalForOrg } from '../../services/dashboard-agent/approvals-store.js';
import { appendMessage, listMessages, type Message } from '../../services/dashboard-agent/store.js';

const mockCallMcpTool = mcpClientModule.callMcpTool as MockedFunction<typeof mcpClientModule.callMcpTool>;

const ORG = 'org-substrate-bridge-test';
const pool = new Pool({ connectionString: process.env.CONTROL_TEST_DATABASE_URL });

beforeEach(async () => {
  vi.clearAllMocks();
  await pool.query(`DELETE FROM dashboard_agent_conversations WHERE organization_id = $1`, [ORG]);
});

afterAll(async () => {
  await pool.query(`DELETE FROM dashboard_agent_conversations WHERE organization_id = $1`, [ORG]);
  await pool.end();
});

/** manage_substrate wraps its JSON payload in an MCP text content block. */
function mcpOk(payload: unknown) {
  return { ok: true as const, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } };
}
function mcpToolError(payload: unknown) {
  return {
    ok: true as const,
    result: { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: true },
  };
}

/** What loop.ts leaves behind when it pauses the turn on a gated tool call. */
async function pauseOnGatedTool(toolArgs: unknown) {
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
      content: 'Proposing that to the substrate.',
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

function toolRow(messages: Message[], toolCallId: string): Message | undefined {
  return messages.find((m) => m.role === 'tool' && m.toolCallId === toolCallId);
}

const GATED_PROPOSE = { action: 'propose', capability: 'amend_principle', payload: { title: 'x' } };

describe('C2b — one human approval executes the capability', () => {
  it('bridges a gated propose to substrate native approve, exactly once, and the turn sees the EXECUTED result', async () => {
    const { conversationId, approval, toolCallId } = await pauseOnGatedTool(GATED_PROPOSE);

    mockCallMcpTool
      // 1. the replayed propose — substrate gates it and parks a pending action
      .mockResolvedValueOnce(
        mcpOk({
          action_id: 'act_gated_1',
          verdict: { result: 'requires_approval', reason: 'default_policy', conflicts: [] },
          requires_approval: true,
        }),
      )
      // 2. the bridge's native approve — substrate executes
      .mockResolvedValueOnce(mcpOk({ executed: true, result: { principle_id: 'prin_9' } }));

    const outcome = await resolveOperatorApproval(pool, {
      approvalId: approval.id,
      orgId: ORG,
      jwt: 'jwt-token',
      resolution: { status: 'approved' },
    });
    expect(outcome).toEqual({ ok: true });

    // TWO calls, in order: propose then approve. Not one (the old bug: a
    // second pending approval), not three.
    expect(mockCallMcpTool).toHaveBeenCalledTimes(2);
    const [proposeCall, approveCall] = mockCallMcpTool.mock.calls;
    expect(proposeCall[0]).toBe('manage_substrate');
    expect((proposeCall[1] as Record<string, unknown>).action).toBe('propose');
    expect(approveCall[0]).toBe('manage_substrate');
    expect(approveCall[1]).toEqual({ action: 'approve', action_id: 'act_gated_1' });

    // dangerously_skip_approval is never introduced by the bridge — it would
    // silently fail on exactly the capabilities that matter (not yolo_eligible).
    for (const call of mockCallMcpTool.mock.calls) {
      expect(call[1]).not.toHaveProperty('dangerously_skip_approval');
    }

    // The turn resumes with the executed outcome, not the pending propose.
    const row = toolRow(await listMessages(pool, conversationId), toolCallId);
    expect(row).toBeDefined();
    const text = (row!.toolResult as { content: { text: string }[] }).content[0].text;
    expect(JSON.parse(text)).toEqual({ executed: true, result: { principle_id: 'prin_9' } });
    expect(text).not.toContain('requires_approval');

    const stored = await getApprovalForOrg(pool, approval.id, ORG);
    expect(stored?.status).toBe('approved');
  });

  it('injects the approval id as substrate idempotency_key so a crash before COMMIT cannot re-propose', async () => {
    const { approval } = await pauseOnGatedTool(GATED_PROPOSE);

    mockCallMcpTool
      .mockResolvedValueOnce(mcpOk({ action_id: 'act_gated_2', requires_approval: true }))
      .mockResolvedValueOnce(mcpOk({ executed: true }));

    await resolveOperatorApproval(pool, {
      approvalId: approval.id,
      orgId: ORG,
      jwt: 'jwt-token',
      resolution: { status: 'approved' },
    });

    expect(mockCallMcpTool.mock.calls[0][1]).toMatchObject({
      action: 'propose',
      idempotency_key: approval.id,
    });
  });

  it("does not overwrite an idempotency_key the agent supplied", async () => {
    const { approval } = await pauseOnGatedTool({ ...GATED_PROPOSE, idempotency_key: 'agent-key' });

    mockCallMcpTool
      .mockResolvedValueOnce(mcpOk({ action_id: 'act_gated_3', requires_approval: true }))
      .mockResolvedValueOnce(mcpOk({ executed: true }));

    await resolveOperatorApproval(pool, {
      approvalId: approval.id,
      orgId: ORG,
      jwt: 'jwt-token',
      resolution: { status: 'approved' },
    });

    expect(mockCallMcpTool.mock.calls[0][1]).toMatchObject({ idempotency_key: 'agent-key' });
  });
});

describe('C2b — no second call when substrate did not gate', () => {
  it('requires_approval:false (auto capability) makes exactly one call', async () => {
    const { conversationId, approval, toolCallId } = await pauseOnGatedTool({
      action: 'propose',
      capability: 'record_decision',
      payload: {},
    });

    mockCallMcpTool.mockResolvedValue(
      mcpOk({ action_id: 'act_auto', requires_approval: false, result: { decision_id: 'dec_1' } }),
    );

    const outcome = await resolveOperatorApproval(pool, {
      approvalId: approval.id,
      orgId: ORG,
      jwt: 'jwt-token',
      resolution: { status: 'approved' },
    });
    expect(outcome).toEqual({ ok: true });
    expect(mockCallMcpTool).toHaveBeenCalledTimes(1);

    const row = toolRow(await listMessages(pool, conversationId), toolCallId);
    expect(row).toBeDefined();
  });

  it('a replay of an already-executed action (requires_approval:false) makes no second call', async () => {
    const { approval } = await pauseOnGatedTool(GATED_PROPOSE);

    // buildReplayResult sets requires_approval = (status === 'proposed'), so an
    // action past `proposed` replays as false.
    mockCallMcpTool.mockResolvedValue(
      mcpOk({ action_id: 'act_replay', requires_approval: false, replay: true, result: { ok: true } }),
    );

    await resolveOperatorApproval(pool, {
      approvalId: approval.id,
      orgId: ORG,
      jwt: 'jwt-token',
      resolution: { status: 'approved' },
    });
    expect(mockCallMcpTool).toHaveBeenCalledTimes(1);
  });

  it('a non-propose gated action (create_rule) is executed directly, with no bridge call', async () => {
    const { approval } = await pauseOnGatedTool({ action: 'create_rule', rule: { name: 'r' } });

    mockCallMcpTool.mockResolvedValue(mcpOk({ rule_id: 'rule_1' }));

    const outcome = await resolveOperatorApproval(pool, {
      approvalId: approval.id,
      orgId: ORG,
      jwt: 'jwt-token',
      resolution: { status: 'approved' },
    });
    expect(outcome).toEqual({ ok: true });
    expect(mockCallMcpTool).toHaveBeenCalledTimes(1);
    expect(mockCallMcpTool.mock.calls[0][1]).not.toHaveProperty('idempotency_key');
  });
});

describe('C2b — deny proposes nothing', () => {
  it('denying a gated propose calls substrate not at all, and still completes the history', async () => {
    const { conversationId, approval, toolCallId } = await pauseOnGatedTool(GATED_PROPOSE);

    const outcome = await resolveOperatorApproval(pool, {
      approvalId: approval.id,
      orgId: ORG,
      jwt: 'jwt-token',
      resolution: { status: 'denied', reason: 'not this quarter' },
    });
    expect(outcome).toEqual({ ok: true });

    // loop.ts pauses BEFORE dispatch, so nothing was ever proposed — there is
    // no pending substrate action left behind to reject.
    expect(mockCallMcpTool).not.toHaveBeenCalled();

    // C2 invariants still hold on the deny path.
    const messages = await listMessages(pool, conversationId);
    const row = toolRow(messages, toolCallId);
    expect(row).toBeDefined();
    expect(row!.toolResult).toMatchObject({ ok: false });
    const paused = messages.find((m) => m.role === 'assistant' && m.toolCallId === toolCallId);
    expect(paused?.pendingApprovalId ?? null).toBeNull();
    expect((await getApprovalForOrg(pool, approval.id, ORG))?.status).toBe('denied');
  });
});

describe('C2b — the bridge is not permission for the operator to approve', () => {
  it("principal 'operator' cannot call manage_substrate approve", async () => {
    const { approval } = await pauseOnGatedTool({ action: 'approve', action_id: 'act_x' });

    const result = await executeOnce(pool, {
      approvalId: approval.id,
      name: 'manage_substrate',
      args: { action: 'approve', action_id: 'act_x' },
      jwt: 'jwt-token',
      orgId: ORG,
      principal: 'operator',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('not permitted for the operator');
    expect(mockCallMcpTool).not.toHaveBeenCalled();
  });

  it("principal 'operator' cannot call manage_substrate reject", async () => {
    const { approval } = await pauseOnGatedTool({ action: 'reject', action_id: 'act_x' });

    const result = await executeOnce(pool, {
      approvalId: approval.id,
      name: 'manage_substrate',
      args: { action: 'reject', action_id: 'act_x', reason: 'no' },
      jwt: 'jwt-token',
      orgId: ORG,
      principal: 'operator',
    });

    expect(result.ok).toBe(false);
    expect(mockCallMcpTool).not.toHaveBeenCalled();
  });
});

describe('C2b — a failed follow-up approve does not wedge the conversation', () => {
  it('surfaces 502, leaves the approval pending, writes no partial history, and does not re-propose on retry', async () => {
    const { conversationId, approval, toolCallId } = await pauseOnGatedTool(GATED_PROPOSE);

    mockCallMcpTool
      .mockResolvedValueOnce(mcpOk({ action_id: 'act_gated_4', requires_approval: true }))
      .mockResolvedValueOnce(mcpToolError({ error: 'action is not in proposed state (status=executed)' }));

    const outcome = await resolveOperatorApproval(pool, {
      approvalId: approval.id,
      orgId: ORG,
      jwt: 'jwt-token',
      resolution: { status: 'approved' },
    });
    expect(outcome.ok).toBe(false);
    expect(outcome).toMatchObject({ code: 502 });

    // No half-written history: no tool row, marker intact, approval still open.
    const messages = await listMessages(pool, conversationId);
    expect(toolRow(messages, toolCallId)).toBeUndefined();
    const paused = messages.find((m) => m.role === 'assistant' && m.toolCallId === toolCallId);
    expect(paused?.pendingApprovalId).toBe(approval.id);
    expect((await getApprovalForOrg(pool, approval.id, ORG))?.status).toBe('pending');

    // Retry: the propose is served from executeOnce's cache — the capability is
    // NOT proposed a second time — and the retried approve completes the turn.
    mockCallMcpTool.mockResolvedValueOnce(mcpOk({ executed: true, result: { ok: true } }));

    const retry = await resolveOperatorApproval(pool, {
      approvalId: approval.id,
      orgId: ORG,
      jwt: 'jwt-token',
      resolution: { status: 'approved' },
    });
    expect(retry).toEqual({ ok: true });

    // 3 total: propose, failed approve, retried approve. No second propose.
    expect(mockCallMcpTool).toHaveBeenCalledTimes(3);
    expect(
      mockCallMcpTool.mock.calls.filter(
        (c) => (c[1] as Record<string, unknown>).action === 'propose',
      ),
    ).toHaveLength(1);

    expect(toolRow(await listMessages(pool, conversationId), toolCallId)).toBeDefined();
  });

  it('a transport failure on the approve leg is reported, not swallowed', async () => {
    const { approval } = await pauseOnGatedTool(GATED_PROPOSE);

    mockCallMcpTool
      .mockResolvedValueOnce(mcpOk({ action_id: 'act_gated_5', requires_approval: true }))
      .mockResolvedValueOnce({ ok: false, error: 'mcp 504' });

    const outcome = await resolveOperatorApproval(pool, {
      approvalId: approval.id,
      orgId: ORG,
      jwt: 'jwt-token',
      resolution: { status: 'approved' },
    });
    expect(outcome).toMatchObject({ code: 502 });
    expect((outcome as { error: string }).error).toContain('substrate approve failed');
    expect((await getApprovalForOrg(pool, approval.id, ORG))?.status).toBe('pending');
  });

  it('requires_approval with no action_id fails closed rather than guessing', async () => {
    const { approval } = await pauseOnGatedTool(GATED_PROPOSE);

    mockCallMcpTool.mockResolvedValueOnce(mcpOk({ requires_approval: true }));

    const outcome = await resolveOperatorApproval(pool, {
      approvalId: approval.id,
      orgId: ORG,
      jwt: 'jwt-token',
      resolution: { status: 'approved' },
    });
    expect(outcome).toMatchObject({ code: 502 });
    expect(mockCallMcpTool).toHaveBeenCalledTimes(1);
  });

  it('a propose that substrate itself rejected is surfaced unchanged, with no approve attempt', async () => {
    const { approval } = await pauseOnGatedTool(GATED_PROPOSE);

    mockCallMcpTool.mockResolvedValueOnce(mcpToolError({ error: 'capability blocked by principle' }));

    const outcome = await resolveOperatorApproval(pool, {
      approvalId: approval.id,
      orgId: ORG,
      jwt: 'jwt-token',
      resolution: { status: 'approved' },
    });
    // callMcpTool reported ok, so this resolves — the model sees the error text.
    expect(outcome).toEqual({ ok: true });
    expect(mockCallMcpTool).toHaveBeenCalledTimes(1);
  });
});
