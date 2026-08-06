/**
 * Fix E — SUBSTRATE-ESCALATED approvals reach the operator feed.
 *
 * THE GAP. Our pre-dispatch gate derives from a STATIC MIRROR of the eight
 * capabilities whose substrate `default_policy` is 'approval_required'. That
 * mirror is documented in operator-policy.ts as "the FLOOR, not the ceiling":
 * substrate's policy engine ALSO escalates at PROPOSE time — a principle
 * conflict returns `requires_approval` even for a capability whose
 * `default_policy` is 'auto', per org, dynamically.
 *
 * Those calls get verdict 'allow', dispatch, and come back
 * `{ action_id, requires_approval: true }`. Substrate held the line — nothing
 * executed — but no dashboard approval was created, so the action parked in
 * substrate's ledger where the operator feed cannot see it, and the operator's
 * own route to resolve it (`manage_substrate approve`) is correctly denied to
 * it. The work stalled silently and every wake burned a cycle rediscovering it.
 *
 * This file pins the LOOP half: what the dispatch site does with such a
 * response. The resolution half — approve calls substrate's native
 * approve(action_id) exactly once and never re-proposes, deny rejects the
 * parked action, both write the role:'tool' row and clear pending_approval_id —
 * is pinned in routes/__tests__/operator-escalation-approval.test.ts against
 * the real control-plane DB.
 *
 * Deliberately uses the REAL tool-catalog.ts, operator-policy.ts and the real
 * substrate-approval-bridge reader. Only I/O and the two approval WRITERS are
 * mocked.
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';
import type pg from 'pg';

vi.mock('../store.js', () => ({
  appendMessage: vi.fn(),
  listMessages: vi.fn(),
  getRecentToolArgs: vi.fn(),
  upsertSnapshotLabel: vi.fn(),
  getConversation: vi.fn(),
  updateConversationTitle: vi.fn(),
}));

vi.mock('../mcp-client.js', () => ({
  callMcpTool: vi.fn(),
}));

/**
 * importActual-spread, NOT a bare object: substrate-approval-bridge.ts imports
 * `isValidSubstrateActionId` and `readSubstrateEscalationActionId` from this
 * module, and the reader under test would silently become a no-op if they were
 * stubbed away. Only the two writers are replaced.
 */
vi.mock('../approvals-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../approvals-store.js')>();
  return {
    ...actual,
    createApproval: vi.fn(),
    checkTrust: vi.fn(),
    createSubstrateEscalationApproval: vi.fn(),
  };
});

import * as storeModule from '../store.js';
import * as mcpClientModule from '../mcp-client.js';
import * as approvalsStoreModule from '../approvals-store.js';
import { operatorUserId } from '../operator-store.js';
import { SUBSTRATE_APPROVAL_REQUIRED_CAPABILITIES } from '../operator-policy.js';
import { runAgentTurn, type LoopEvent } from '../loop.js';

const mockAppendMessage = storeModule.appendMessage as MockedFunction<typeof storeModule.appendMessage>;
const mockListMessages = storeModule.listMessages as MockedFunction<typeof storeModule.listMessages>;
const mockGetRecentToolArgs = storeModule.getRecentToolArgs as MockedFunction<typeof storeModule.getRecentToolArgs>;
const mockGetConversation = storeModule.getConversation as MockedFunction<typeof storeModule.getConversation>;
const mockUpdateConversationTitle = storeModule.updateConversationTitle as MockedFunction<typeof storeModule.updateConversationTitle>;
const mockCallMcpTool = mcpClientModule.callMcpTool as MockedFunction<typeof mcpClientModule.callMcpTool>;
const mockCreateApproval = approvalsStoreModule.createApproval as MockedFunction<typeof approvalsStoreModule.createApproval>;
const mockCheckTrust = approvalsStoreModule.checkTrust as MockedFunction<typeof approvalsStoreModule.checkTrust>;
const mockCreateEscalation = approvalsStoreModule.createSubstrateEscalationApproval as MockedFunction<
  typeof approvalsStoreModule.createSubstrateEscalationApproval
>;

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const OPERATOR_USER = operatorUserId(ORG_ID);
const HUMAN_USER = 'cognito-sub-abc';
const stubPool = {} as pg.Pool;

/**
 * A capability substrate would normally auto-approve. The whole point of this
 * file is the case the static mirror CANNOT predict, so the test would be
 * vacuous if it used a capability that pauses pre-dispatch.
 */
const AUTO_CAPABILITY = 'record_decision';

const ASSISTANT_ROW_ID = 'msg-assistant-1';

function stubRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg-stub',
    conversationId: 'conv-1',
    role: 'user' as const,
    content: '',
    toolCallId: null,
    toolName: null,
    toolArgs: null,
    toolResult: null,
    modelUsed: null,
    pendingApprovalId: null,
    createdAt: new Date(),
    ...overrides,
  };
}

async function collect(gen: AsyncGenerator<LoopEvent>): Promise<LoopEvent[]> {
  const events: LoopEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

function makeSseStream(deltas: object[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const lines = deltas.map((d) => `data: ${JSON.stringify(d)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(lines));
      controller.close();
    },
  });
}

function gatewayResponse(deltas: object[]) {
  return { ok: true, body: makeSseStream(deltas) } as unknown as Response;
}

function oneToolCallThenStop(name: string, args: unknown) {
  let pass = 0;
  global.fetch = vi.fn(async () => {
    pass++;
    if (pass === 1) {
      return gatewayResponse([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name, arguments: '' } }] }, finish_reason: null }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      ]);
    }
    return gatewayResponse([
      { choices: [{ delta: { content: 'ok' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]);
  }) as unknown as typeof fetch;
}

/** The MCP envelope manage_substrate actually returns: JSON in a text block. */
function substrateResult(payload: unknown) {
  return { ok: true, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } };
}

function operatorInput(overrides: Record<string, unknown> = {}) {
  return {
    conversationId: 'conv-1',
    userId: OPERATOR_USER,
    jwt: 'operator-service-key',
    userMessage: 'Scheduled wake.',
    model: 'claude-sonnet-4-5',
    pool: stubPool,
    organizationId: ORG_ID,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // The assistant tool-call row is the one the escalation must anchor to, so
  // it has to come back with a stable, distinguishable id.
  mockAppendMessage.mockImplementation(async (_p, _c, msg) =>
    (msg.role === 'assistant' && msg.toolCallId
      ? stubRow({ id: ASSISTANT_ROW_ID, role: 'assistant', toolCallId: msg.toolCallId })
      : stubRow()) as never,
  );
  mockListMessages.mockResolvedValue([]);
  mockGetRecentToolArgs.mockResolvedValue([]);
  mockGetConversation.mockResolvedValue(null);
  mockUpdateConversationTitle.mockResolvedValue(null);
  mockCheckTrust.mockResolvedValue(false);
  mockCreateApproval.mockResolvedValue({ id: 'approval-preempt' } as never);
  mockCreateEscalation.mockResolvedValue({ id: 'approval-escalated' } as never);
});

describe('fix E — a dispatched propose that comes back requires_approval', () => {
  it('is NOT one of the statically-mirrored capabilities (guards this file from going vacuous)', () => {
    expect(SUBSTRATE_APPROVAL_REQUIRED_CAPABILITIES.has(AUTO_CAPABILITY)).toBe(false);
  });

  it('raises an operator approval anchored to the paused assistant row', async () => {
    oneToolCallThenStop('manage_substrate', { action: 'propose', capability: AUTO_CAPABILITY, payload: { x: 1 } });
    mockCallMcpTool.mockResolvedValue(
      substrateResult({ action_id: 'act_01HZX9', verdict: 'allow', requires_approval: true }) as never,
    );

    const events = await collect(runAgentTurn(operatorInput()));

    // The propose DID dispatch — this is the post-dispatch case, not a
    // pre-emption, and substrate is the one that held the line.
    expect(mockCallMcpTool).toHaveBeenCalledTimes(1);

    expect(mockCreateEscalation).toHaveBeenCalledTimes(1);
    expect(mockCreateEscalation).toHaveBeenCalledWith(stubPool, {
      conversationId: 'conv-1',
      pausedMessageId: ASSISTANT_ROW_ID,
      actionId: 'act_01HZX9',
    });

    // The feed sees it.
    const approvalEvent = events.find((e) => e.type === 'approval_required') as
      | Extract<LoopEvent, { type: 'approval_required' }>
      | undefined;
    expect(approvalEvent).toBeDefined();
    expect(approvalEvent!.approval_id).toBe('approval-escalated');

    // The turn stops there rather than carrying on as if the work landed.
    expect(events.some((e) => e.type === 'tool_result')).toBe(false);
  });

  it('takes the action id from SUBSTRATE\'S RESPONSE, never from the model\'s arguments', async () => {
    // The model supplies a DIFFERENT action_id in its own args. If the writer
    // ever sourced the id from there, an operator could aim a human's approve
    // click at an action it did not propose.
    oneToolCallThenStop('manage_substrate', {
      action: 'propose',
      capability: AUTO_CAPABILITY,
      action_id: 'act_ATTACKER_CHOSEN',
    });
    mockCallMcpTool.mockResolvedValue(
      substrateResult({ action_id: 'act_FROM_SUBSTRATE', requires_approval: true }) as never,
    );

    await collect(runAgentTurn(operatorInput()));

    expect(mockCreateEscalation).toHaveBeenCalledTimes(1);
    expect(mockCreateEscalation.mock.calls[0][1].actionId).toBe('act_FROM_SUBSTRATE');
  });

  it('does NOT write a role:tool row for the propose — the turn pauses, it does not answer itself', async () => {
    oneToolCallThenStop('manage_substrate', { action: 'propose', capability: AUTO_CAPABILITY });
    mockCallMcpTool.mockResolvedValue(substrateResult({ action_id: 'act_1', requires_approval: true }) as never);

    await collect(runAgentTurn(operatorInput()));

    const toolRows = mockAppendMessage.mock.calls.filter((c) => c[2].role === 'tool');
    expect(toolRows).toHaveLength(0);
  });
});

describe('fix E — cases that must NOT raise an approval', () => {
  it('requires_approval: false creates no approval and records an ordinary tool result', async () => {
    oneToolCallThenStop('manage_substrate', { action: 'propose', capability: AUTO_CAPABILITY });
    mockCallMcpTool.mockResolvedValue(
      substrateResult({ action_id: 'act_1', verdict: 'auto_approved', requires_approval: false, result: { ok: true } }) as never,
    );

    const events = await collect(runAgentTurn(operatorInput()));

    expect(mockCreateEscalation).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === 'approval_required')).toBe(false);
    expect(events.some((e) => e.type === 'tool_result')).toBe(true);
    expect(mockAppendMessage.mock.calls.some((c) => c[2].role === 'tool')).toBe(true);
  });

  it('a non-propose substrate action is untouched', async () => {
    oneToolCallThenStop('manage_substrate', { action: 'list_actions' });
    // Deliberately a response shaped like an escalation: the ACTION is what
    // decides, so a list result that happens to carry these keys must not pause.
    mockCallMcpTool.mockResolvedValue(substrateResult({ action_id: 'act_1', requires_approval: true }) as never);

    await collect(runAgentTurn(operatorInput()));

    expect(mockCreateEscalation).not.toHaveBeenCalled();
  });

  it('a tool-level error envelope raises nothing', async () => {
    oneToolCallThenStop('manage_substrate', { action: 'propose', capability: AUTO_CAPABILITY });
    mockCallMcpTool.mockResolvedValue({
      ok: true,
      result: { isError: true, content: [{ type: 'text', text: JSON.stringify({ action_id: 'act_1', requires_approval: true }) }] },
    } as never);

    await collect(runAgentTurn(operatorInput()));

    expect(mockCreateEscalation).not.toHaveBeenCalled();
  });

  it('the HUMAN assistant is not affected', async () => {
    oneToolCallThenStop('manage_substrate', { action: 'propose', capability: AUTO_CAPABILITY });
    mockCallMcpTool.mockResolvedValue(substrateResult({ action_id: 'act_1', requires_approval: true }) as never);

    const events = await collect(
      runAgentTurn({
        conversationId: 'conv-1',
        userId: HUMAN_USER,
        jwt: 'user-jwt',
        userMessage: 'propose that',
        model: 'claude-sonnet-4-5',
        pool: stubPool,
        organizationId: ORG_ID,
      }),
    );

    expect(mockCreateEscalation).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === 'approval_required')).toBe(false);
    expect(events.some((e) => e.type === 'tool_result')).toBe(true);
  });

  it('a pre-empted (statically mirrored) capability still pauses BEFORE dispatch', async () => {
    // Regression guard for the boundary between the two mechanisms: the old
    // path must not start dispatching just because a post-dispatch path exists.
    oneToolCallThenStop('manage_substrate', { action: 'propose', capability: 'delete_entity' });

    const events = await collect(runAgentTurn(operatorInput()));

    expect(mockCallMcpTool).not.toHaveBeenCalled();
    expect(mockCreateEscalation).not.toHaveBeenCalled();
    expect(mockCreateApproval).toHaveBeenCalledTimes(1);
    const approvalEvent = events.find((e) => e.type === 'approval_required') as
      | Extract<LoopEvent, { type: 'approval_required' }>
      | undefined;
    expect(approvalEvent!.approval_id).toBe('approval-preempt');
  });

  it('falls back to an ordinary tool result if the approval could not be created', async () => {
    // Never a half-paused turn: an assistant tool_call row with no result and
    // no pending approval is the exact history the gateway rejects.
    oneToolCallThenStop('manage_substrate', { action: 'propose', capability: AUTO_CAPABILITY });
    mockCallMcpTool.mockResolvedValue(substrateResult({ action_id: 'act_1', requires_approval: true }) as never);
    mockCreateEscalation.mockResolvedValue(null);

    const events = await collect(runAgentTurn(operatorInput()));

    expect(events.some((e) => e.type === 'approval_required')).toBe(false);
    expect(mockAppendMessage.mock.calls.some((c) => c[2].role === 'tool')).toBe(true);
  });
});
