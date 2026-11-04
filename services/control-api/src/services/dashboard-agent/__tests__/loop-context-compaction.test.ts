vi.mock('../../api-key-service.js', () => ({ ApiKeyService: { validateApiKey: vi.fn(async () => ({ organizationLocked: false })) } }));
/**
 * Turn-start wiring: compaction sees the UNTRIMMED operator history, and the
 * summary block lands in the single system message the gateway receives.
 *
 * The loop's other tests do NOT mock context-compaction.ts; they are the
 * regression proof that an under-budget history never touches the summary
 * store or the helper gateway.
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

vi.mock('../context-compaction.js', () => ({
  compactReplay: vi.fn(async ({ messages }) => ({
    messages,
    summary: 'EARLIER CONTEXT',
    compacted: true,
    trigger: 'summarized',
    beforeChars: 2,
    afterChars: 1,
  })),
  compactInFlight: vi.fn(async ({ messages }) => ({
    blocked: false,
    rebuilt: false,
    messages,
  })),
}));

import * as storeModule from '../store.js';
import * as mcpClientModule from '../mcp-client.js';
import * as approvalsStoreModule from '../approvals-store.js';
import * as compactionModule from '../context-compaction.js';
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
const mockCompactReplay = compactionModule.compactReplay as MockedFunction<typeof compactionModule.compactReplay>;

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

describe('turn-start compaction', () => {
  it('compacts untrimmed operator history and injects the summary block', async () => {
    const history = Array.from({ length: 60 }, (_, i) => ({
      ...stubMessage,
      id: `m${i}`,
      content: `message ${i}`,
    }));
    mockListMessages.mockResolvedValue(history as never);
    const { bodies } = finalAnswer();

    const events = await collect(operatorTurn());

    expect(events.some((e) => e.type === 'done')).toBe(true);
    const call = mockCompactReplay.mock.calls[0][0];
    expect(call.messages).toHaveLength(60);
    expect(call.budgetChars).toBe(150_000);
    expect(bodies[0]).toContain('# Conversation summary so far');
    expect(bodies[0]).toContain('EARLIER CONTEXT');
  });
});
