vi.mock('../../api-key-service.js', () => ({ ApiKeyService: { validateApiKey: vi.fn(async () => ({ organizationLocked: false })) } }));
/**
 * Mid-turn compaction: the check before EVERY model request.
 *
 * The real context-compaction.ts is used. Clearing is the lever under test:
 * the third request must see the first 5k result as a stub and the latest one
 * verbatim. The last-resort case proves the turn stops cleanly rather than
 * sending an over-ceiling request.
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';
import type pg from 'pg';

vi.hoisted(() => {
  process.env.DASHBOARD_AGENT_MIDTURN_CEILING_CHARS = '36000';
  process.env.DASHBOARD_AGENT_MIDTURN_KEEP_TOOL_RESULTS = '1';
});

vi.mock('../store.js', () => ({
  appendMessage: vi.fn(),
  listMessages: vi.fn(),
  getRecentToolArgs: vi.fn(),
  getToolResultMessage: vi.fn(),
  getToolMessageIds: vi.fn(),
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

vi.mock('../snapshot-title.js', () => ({
  createGatewayChat: vi.fn(() => ({ chat: vi.fn(async () => 'PRETURN SUMMARY') })),
  deriveSnapshotTitle: vi.fn(async () => 'title'),
}));

vi.mock('../context-summary-store.js', () => ({
  getContextSummary: vi.fn(async () => null),
  upsertContextSummary: vi.fn(async () => {}),
}));

import * as storeModule from '../store.js';
import * as mcpClientModule from '../mcp-client.js';
import * as approvalsStoreModule from '../approvals-store.js';
import { operatorUserId } from '../operator-store.js';
import { runAgentTurn, type LoopEvent } from '../loop.js';

const mockAppendMessage = storeModule.appendMessage as MockedFunction<typeof storeModule.appendMessage>;
const mockListMessages = storeModule.listMessages as MockedFunction<typeof storeModule.listMessages>;
const mockGetRecentToolArgs = storeModule.getRecentToolArgs as MockedFunction<typeof storeModule.getRecentToolArgs>;
const mockGetToolMessageIds = storeModule.getToolMessageIds as MockedFunction<typeof storeModule.getToolMessageIds>;
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
  content: 'wake',
  toolCallId: null,
  toolName: null,
  toolArgs: null,
  toolResult: null,
  modelUsed: null,
  pendingApprovalId: null,
  rating: null,
  ratingReason: null,
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

function toolCallRound(id: string) {
  return gatewayResponse([
    { choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name: 'select_rows', arguments: '' } }] }, finish_reason: null }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ app_id: 'a1', table: 't' }) } }] }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ]);
}

function twoToolCallsThenStop() {
  const bodies: string[] = [];
  let round = 0;
  const fetchMock = vi.fn(async (_url: unknown, init?: unknown) => {
    bodies.push((init as { body?: string } | undefined)?.body ?? '');
    round += 1;
    if (round === 1) return toolCallRound('call-1');
    if (round === 2) return toolCallRound('call-2');
    return gatewayResponse([
      { choices: [{ delta: { content: 'ok' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return { bodies, fetchMock };
}

function oneToolCallThenStop() {
  const bodies: string[] = [];
  let round = 0;
  const fetchMock = vi.fn(async (_url: unknown, init?: unknown) => {
    bodies.push((init as { body?: string } | undefined)?.body ?? '');
    round += 1;
    if (round === 1) return toolCallRound('call-1');
    return gatewayResponse([
      { choices: [{ delta: { content: 'ok' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return { bodies };
}

function finalAnswer() {
  const bodies: string[] = [];
  const fetchMock = vi.fn(async (_url: unknown, init?: unknown) => {
    bodies.push((init as { body?: string } | undefined)?.body ?? '');
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

function humanTurn() {
  return runAgentTurn({
    conversationId: 'conv-1',
    userId: 'cognito-sub-abc',
    jwt: 'user-jwt',
    userMessage: 'current question',
    model: 'test/model',
    pool: stubPool,
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAppendMessage.mockResolvedValue(stubMessage as never);
  mockListMessages.mockResolvedValue([] as never);
  mockGetRecentToolArgs.mockResolvedValue([] as never);
  mockGetConversation.mockResolvedValue(null as never);
  mockCreateApproval.mockResolvedValue({ id: 'appr-new' } as never);
  mockListPendingGatedCalls.mockResolvedValue([] as never);
  mockGetToolMessageIds.mockImplementation(async (_pool, _conversationId, ids) =>
    new Map(ids.map((id) => [id, `row-${id}`])));
  mockCallMcpTool
    .mockResolvedValueOnce({ ok: true, result: 'a'.repeat(5_000) } as never)
    .mockResolvedValueOnce({ ok: true, result: 'b'.repeat(5_000) } as never);
});

describe('mid-turn compaction', () => {
  it('clears old tool results before the third request', async () => {
    const { bodies } = twoToolCallsThenStop();

    const events = await collect(operatorTurn());

    expect(events.some((e) => e.type === 'done')).toBe(true);
    expect(bodies).toHaveLength(3);
    expect(bodies[2]).toContain('cleared');
    expect(bodies[2]).not.toContain('a'.repeat(5_000));
    expect(bodies[2]).toContain('b'.repeat(5_000));
  });

  it('caps an oversized same-turn result and keeps it recoverable', async () => {
    const previous = process.env.DASHBOARD_AGENT_MIDTURN_CEILING_CHARS;
    process.env.DASHBOARD_AGENT_MIDTURN_CEILING_CHARS = '900000';
    mockCallMcpTool.mockReset();
    mockCallMcpTool.mockResolvedValueOnce({ ok: true, result: 'z'.repeat(100_000) } as never);
    const { bodies } = oneToolCallThenStop();

    try {
      const events = await collect(operatorTurn());
      expect(events.some((e) => e.type === 'done')).toBe(true);
      expect(bodies).toHaveLength(2);
      expect(bodies[1]).toContain('truncated');
      expect(bodies[1]).toContain('row-call-1');
      expect(bodies[1]).not.toContain('z'.repeat(100_000));
    } finally {
      process.env.DASHBOARD_AGENT_MIDTURN_CEILING_CHARS = previous;
    }
  });

  it('force-summarizes the pre-turn prefix and preserves the current turn', async () => {
    const previous = process.env.DASHBOARD_AGENT_MIDTURN_CEILING_CHARS;
    process.env.DASHBOARD_AGENT_MIDTURN_CEILING_CHARS = '150000';
    const history = Array.from({ length: 100 }, (_, i) => ({
      ...stubMessage,
      id: `m${i}`,
      content: 'x'.repeat(2_000),
    }));
    history.push({ ...stubMessage, id: 'current', content: 'current question' });
    mockListMessages.mockResolvedValue(history as never);
    const { bodies } = finalAnswer();

    try {
      const events = await collect(humanTurn());
      expect(events.some((e) => e.type === 'done')).toBe(true);
      expect(bodies[0]).toContain('# Conversation summary so far');
      expect(bodies[0]).toContain('PRETURN SUMMARY');
      expect(bodies[0]).toContain('current question');
    } finally {
      process.env.DASHBOARD_AGENT_MIDTURN_CEILING_CHARS = previous;
    }
  });

  it('stops the turn cleanly when even clearing cannot get under the ceiling', async () => {
    const previous = process.env.DASHBOARD_AGENT_MIDTURN_CEILING_CHARS;
    process.env.DASHBOARD_AGENT_MIDTURN_CEILING_CHARS = '1';
    mockListMessages.mockResolvedValue([stubMessage] as never);
    const fetchMock = vi.fn(async () => { throw new Error('fetch should not be called'); });
    global.fetch = fetchMock as unknown as typeof fetch;

    try {
      const events = await collect(operatorTurn());
      expect(events.find((e) => e.type === 'blocked')).toMatchObject({
        type: 'blocked',
        reason: 'context_limit',
      });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      process.env.DASHBOARD_AGENT_MIDTURN_CEILING_CHARS = previous;
    }
  });
});
