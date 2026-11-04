vi.mock('../../api-key-service.js', () => ({ ApiKeyService: { validateApiKey: vi.fn(async () => ({ organizationLocked: false })) } }));
/**
 * `read_tool_result` at the dispatch site.
 *
 * Built on loop-operator-pending-guard.test.ts's harness: the real
 * tool-catalog.ts and loop.ts, with store/mcp/approvals mocked. The point is
 * that the tool is handled IN-PROCESS (never forwarded to MCP), that a
 * conversation-scoped miss is reported as not found without revealing why, and
 * that malformed arguments never reach the store.
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';
import type pg from 'pg';

vi.mock('../store.js', () => ({
  appendMessage: vi.fn(),
  listMessages: vi.fn(),
  getRecentToolArgs: vi.fn(),
  getToolResultMessage: vi.fn(),
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
import { operatorUserId } from '../operator-store.js';
import { runAgentTurn, type LoopEvent } from '../loop.js';

const mockAppendMessage = storeModule.appendMessage as MockedFunction<typeof storeModule.appendMessage>;
const mockListMessages = storeModule.listMessages as MockedFunction<typeof storeModule.listMessages>;
const mockGetRecentToolArgs = storeModule.getRecentToolArgs as MockedFunction<typeof storeModule.getRecentToolArgs>;
const mockGetToolResultMessage = storeModule.getToolResultMessage as MockedFunction<typeof storeModule.getToolResultMessage>;
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

describe('read_tool_result dispatch', () => {
  it('returns a slice of the stored result', async () => {
    mockGetToolResultMessage.mockResolvedValueOnce({
      id: 'm1',
      toolResult: { body: 'hello world' },
    });
    oneToolCallThenStop('read_tool_result', { message_id: 'm1', limit: 5 });

    const events = await collect(operatorTurn());
    const tool = events.find((e) => e.type === 'tool_result');
    expect(tool).toMatchObject({
      type: 'tool_result',
      result: { message_id: 'm1', offset: 0, returned_characters: 5, text: '{"bod' },
    });
    expect(mockGetToolResultMessage).toHaveBeenCalledWith(stubPool, 'conv-1', 'm1');
    expect(mockCallMcpTool).not.toHaveBeenCalled();
  });

  it('does not leak whether a missing id belongs to another conversation', async () => {
    mockGetToolResultMessage.mockResolvedValueOnce(null);
    oneToolCallThenStop('read_tool_result', { message_id: 'foreign' });

    const events = await collect(operatorTurn());
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({
      type: 'tool_result',
      error: 'tool_result_not_found',
    });
  });

  it('rejects invalid arguments before touching the store', async () => {
    oneToolCallThenStop('read_tool_result', { limit: 10 });

    const events = await collect(operatorTurn());
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({
      type: 'tool_result',
      error: 'invalid_arguments',
    });
    expect(mockGetToolResultMessage).not.toHaveBeenCalled();
  });
});
