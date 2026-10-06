/**
 * LAYER 1 of the re-proposal defence, at the dispatch site — and LAYER 3's
 * tool.
 *
 * The operator no longer stops working while a decision is pending
 * (operator-turn.ts). The failure mode that opens is an operator which wakes
 * every minute and proposes the same email sixty times before the owner is
 * awake. THIS file pins the part that does not depend on the model behaving:
 * an equivalent proposal is refused in code, no second approval row is created,
 * and — for a call that would otherwise have DISPATCHED and escalated inside
 * substrate — nothing is dispatched either.
 *
 * Deliberately built on loop-operator-policy.test.ts's harness, with the REAL
 * tool-catalog.ts, operator-policy.ts and operator-duplicate-guard.ts. A test
 * of a control must not run against a hand-written copy of the table it tests.
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

vi.mock('../approvals-store.js', () => ({
  createApproval: vi.fn(),
  checkTrust: vi.fn(),
  createSubstrateEscalationApproval: vi.fn(),
  listPendingGatedCalls: vi.fn(),
}));

import * as storeModule from '../store.js';
import * as mcpClientModule from '../mcp-client.js';
import * as approvalsStoreModule from '../approvals-store.js';
import { OPERATOR_PENDING_DECISIONS_TOOL } from '../tool-catalog.js';
import { operatorUserId } from '../operator-store.js';
import { runAgentTurn, type LoopEvent } from '../loop.js';

const mockAppendMessage = storeModule.appendMessage as MockedFunction<typeof storeModule.appendMessage>;
const mockListMessages = storeModule.listMessages as MockedFunction<typeof storeModule.listMessages>;
const mockGetRecentToolArgs = storeModule.getRecentToolArgs as MockedFunction<typeof storeModule.getRecentToolArgs>;
const mockGetConversation = storeModule.getConversation as MockedFunction<typeof storeModule.getConversation>;
const mockCallMcpTool = mcpClientModule.callMcpTool as MockedFunction<typeof mcpClientModule.callMcpTool>;
const mockCreateApproval = approvalsStoreModule.createApproval as MockedFunction<typeof approvalsStoreModule.createApproval>;
const mockListPendingGatedCalls = approvalsStoreModule.listPendingGatedCalls as MockedFunction<
  typeof approvalsStoreModule.listPendingGatedCalls
>;

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const OPERATOR_USER = operatorUserId(ORG_ID);
const stubPool = {} as pg.Pool;

const stubMessage = {
  id: 'msg-stub',
  conversationId: 'conv-1',
  role: 'user' as const,
  content: '',
  toolCallId: null,
  toolName: null,
  toolArgs: null,
  toolResult: null,
  modelUsed: null,
  createdAt: new Date(),
};

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
  const bodies: string[] = [];
  const fetchMock = vi.fn(async (_url: unknown, init?: unknown) => {
    bodies.push((init as { body?: string } | undefined)?.body ?? '');
    if (bodies.length === 1) {
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
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return { bodies };
}

function operatorTurn(extra: Record<string, unknown> = {}) {
  return runAgentTurn({
    conversationId: 'conv-1',
    userId: OPERATOR_USER,
    jwt: 'bb_sk_operator',
    userMessage: 'wake',
    model: 'test/model',
    pool: stubPool,
    organizationId: ORG_ID,
    ...extra,
  } as never);
}

/** The `role:'tool'` result the loop wrote back for a given tool_call id. */
function toolResultFor(id: string): unknown {
  const call = mockAppendMessage.mock.calls.find(
    (c) => (c[2] as { role?: string; toolCallId?: string }).role === 'tool' && (c[2] as { toolCallId?: string }).toolCallId === id,
  );
  return call ? (call[2] as { toolResult?: unknown }).toolResult : undefined;
}

const PENDING_EMAIL = {
  approvalId: 'appr-open',
  toolName: 'manage_integrations',
  toolArgs: { action: 'execute', tool_slug: 'GMAIL_SEND_EMAIL', to: 'bob@example.com', body: 'Invoice 42 is overdue.' },
  createdAt: new Date('2026-08-08T00:00:00.000Z').toISOString(),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAppendMessage.mockResolvedValue(stubMessage as never);
  mockListMessages.mockResolvedValue([] as never);
  mockGetRecentToolArgs.mockResolvedValue([] as never);
  mockGetConversation.mockResolvedValue(null as never);
  mockCallMcpTool.mockResolvedValue({ ok: true, result: { ok: true } } as never);
  mockCreateApproval.mockResolvedValue({ id: 'appr-new' } as never);
  mockListPendingGatedCalls.mockResolvedValue([] as never);
});

describe('layer 1 — an equivalent proposal is refused in code', () => {
  it('creates NO second approval row for a byte-identical re-proposal', async () => {
    mockListPendingGatedCalls.mockResolvedValue([PENDING_EMAIL] as never);
    oneToolCallThenStop('manage_integrations', PENDING_EMAIL.toolArgs);

    await collect(operatorTurn());

    expect(mockCreateApproval).not.toHaveBeenCalled();
  });

  it('creates NO second approval row when only the free-text body was reworded', async () => {
    mockListPendingGatedCalls.mockResolvedValue([PENDING_EMAIL] as never);
    oneToolCallThenStop('manage_integrations', {
      action: 'execute', tool_slug: 'GMAIL_SEND_EMAIL', to: 'bob@example.com',
      body: 'Just following up on invoice 42 — it is now well past due.',
    });

    await collect(operatorTurn());

    expect(mockCreateApproval).not.toHaveBeenCalled();
  });

  it('does NOT dispatch the duplicate either — the refusal is pre-dispatch', async () => {
    // Load-bearing for the substrate-escalated kind: that approval is raised
    // AFTER the propose lands in substrate's ledger, so a refusal that let the
    // call through would still park a second real action in substrate.
    mockListPendingGatedCalls.mockResolvedValue([PENDING_EMAIL] as never);
    oneToolCallThenStop('manage_integrations', PENDING_EMAIL.toolArgs);

    await collect(operatorTurn());

    expect(mockCallMcpTool).not.toHaveBeenCalled();
  });

  it('tells the model WHY, as an ordinary tool result naming the open decision', async () => {
    mockListPendingGatedCalls.mockResolvedValue([PENDING_EMAIL] as never);
    oneToolCallThenStop('manage_integrations', PENDING_EMAIL.toolArgs);

    const events = await collect(operatorTurn());

    const result = events.find((e) => e.type === 'tool_result') as { error?: string } | undefined;
    expect(result?.error).toContain('appr-open');
    expect(result?.error).toMatch(/waiting on the owner|already/i);
  });

  it('keeps the assistant/tool pairing closed for the refused call', async () => {
    // A refusal that terminated the turn, or that wrote no `role:'tool'` row,
    // would leave the exact unanswered-tool_call history the gateway rejects.
    mockListPendingGatedCalls.mockResolvedValue([PENDING_EMAIL] as never);
    oneToolCallThenStop('manage_integrations', PENDING_EMAIL.toolArgs);

    await collect(operatorTurn());

    const roles = mockAppendMessage.mock.calls.map((c) => (c[2] as { role: string; toolCallId?: string | null }));
    const assistantIdx = roles.findIndex((r) => r.role === 'assistant' && r.toolCallId === 'call-1');
    const toolIdx = roles.findIndex((r) => r.role === 'tool' && r.toolCallId === 'call-1');
    expect(assistantIdx).toBeGreaterThan(-1);
    expect(toolIdx).toBe(assistantIdx + 1);
  });

  it('lets a genuinely DIFFERENT action through to the gate', async () => {
    mockListPendingGatedCalls.mockResolvedValue([PENDING_EMAIL] as never);
    oneToolCallThenStop('manage_integrations', {
      action: 'execute', tool_slug: 'GMAIL_SEND_EMAIL', to: 'someone-else@example.com', body: 'hi',
    });

    await collect(operatorTurn());

    // manage_integrations is 'allow' in the tier table, so "through" here means
    // it dispatched rather than being refused — the point is the guard did not
    // eat it.
    expect(mockCallMcpTool).toHaveBeenCalledTimes(1);
  });

  it('does nothing at all when no decision is pending', async () => {
    mockListPendingGatedCalls.mockResolvedValue([] as never);
    oneToolCallThenStop('manage_integrations', PENDING_EMAIL.toolArgs);

    await collect(operatorTurn());

    expect(mockCallMcpTool).toHaveBeenCalledTimes(1);
  });

  it('is OPERATOR-ONLY: a human conversation is not consulted and not refused', async () => {
    mockListPendingGatedCalls.mockResolvedValue([PENDING_EMAIL] as never);
    oneToolCallThenStop('select_rows', { app_id: 'a1', table: 't' });

    await collect(
      runAgentTurn({
        conversationId: 'conv-1',
        userId: 'cognito-sub-abc',
        jwt: 'user-jwt',
        userMessage: 'hi',
        model: 'test/model',
        pool: stubPool,
      } as never),
    );

    expect(mockListPendingGatedCalls).not.toHaveBeenCalled();
  });
});

describe('layer 3 — list_pending_decisions', () => {
  it('is offered to the operator', async () => {
    const { bodies } = oneToolCallThenStop(OPERATOR_PENDING_DECISIONS_TOOL, {});
    await collect(operatorTurn());

    const tools = (JSON.parse(bodies[0]) as { tools: Array<{ function: { name: string } }> }).tools.map(
      (t) => t.function.name,
    );
    expect(tools).toContain(OPERATOR_PENDING_DECISIONS_TOOL);
  });

  it('is NOT offered to the human assistant', async () => {
    const { bodies } = oneToolCallThenStop('select_rows', {});
    await collect(
      runAgentTurn({
        conversationId: 'conv-1',
        userId: 'cognito-sub-abc',
        jwt: 'user-jwt',
        userMessage: 'hi',
        model: 'test/model',
        pool: stubPool,
      } as never),
    );

    const tools = (JSON.parse(bodies[0]) as { tools: Array<{ function: { name: string } }> }).tools.map(
      (t) => t.function.name,
    );
    expect(tools).not.toContain(OPERATOR_PENDING_DECISIONS_TOOL);
  });

  it('returns the pending decisions in-process, never via MCP', async () => {
    mockListPendingGatedCalls.mockResolvedValue([PENDING_EMAIL] as never);
    oneToolCallThenStop(OPERATOR_PENDING_DECISIONS_TOOL, {});

    await collect(operatorTurn());

    expect(mockCallMcpTool).not.toHaveBeenCalled();
    const result = toolResultFor('call-1') as { pending?: Array<{ approval_id: string; tool_name: string; tool_args: unknown; waiting: string }> };
    expect(result.pending).toHaveLength(1);
    expect(result.pending?.[0].approval_id).toBe('appr-open');
    expect(result.pending?.[0].tool_name).toBe('manage_integrations');
    // The FULL arguments — the reason this tool exists rather than a longer
    // prompt block.
    expect(result.pending?.[0].tool_args).toEqual(PENDING_EMAIL.toolArgs);
    expect(result.pending?.[0].waiting).toBeTruthy();
  });

  it('collapses the two VIEWS of one escalated decision into a single entry', async () => {
    // listPendingGatedCalls deliberately emits both the approval row and the
    // paused call for the same approval id. That is right for matching and
    // wrong for showing: the owner has one decision, not two.
    mockListPendingGatedCalls.mockResolvedValue([
      { approvalId: 'appr-x', toolName: 'manage_substrate', toolArgs: { action: 'approve', action_id: 'act_1' }, createdAt: PENDING_EMAIL.createdAt },
      { approvalId: 'appr-x', toolName: 'manage_substrate', toolArgs: { action: 'send_email_draft', to: 'bob' }, createdAt: PENDING_EMAIL.createdAt },
    ] as never);
    oneToolCallThenStop(OPERATOR_PENDING_DECISIONS_TOOL, {});

    await collect(operatorTurn());

    const result = toolResultFor('call-1') as { pending?: unknown[] };
    expect(result.pending).toHaveLength(1);
  });

  it('reports an empty queue plainly rather than erroring', async () => {
    mockListPendingGatedCalls.mockResolvedValue([] as never);
    oneToolCallThenStop(OPERATOR_PENDING_DECISIONS_TOOL, {});

    await collect(operatorTurn());

    expect(toolResultFor('call-1')).toEqual({ pending: [], count: 0 });
  });
});
