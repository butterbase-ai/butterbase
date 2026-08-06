/**
 * C3 fix round 1, Finding 2: `repoSync` must not be able to reach the RAW MCP
 * client on an operator turn.
 *
 * `repoSync` is built in `getDefaultDeps` around the unwrapped client, so it is
 * the one `deps.mcp` consumer that would still hold it. Today it is unreachable
 * for an operator — it is entered only from the file-op / deploy /
 * deploy_function routes, whose tool names are all denied. But unreachability is
 * a property of the current contents of OPERATOR_TOOL_ALLOWLIST, not of the
 * code: add any workspace-touching tool to that allowlist later and the operator
 * silently gains `manage_repo` on the org service key, with nothing failing.
 *
 * So this file MOCKS the policy module to widen the allowlist — simulating
 * exactly that future change — and asserts the operator still cannot reach the
 * raw client. The subject under test is the WIRING (does repoSync go through the
 * guard?), not the policy table, which is why replacing the table here is
 * legitimate rather than self-defeating.
 *
 * Separate file because the policy mock is module-wide and must not leak into
 * loop-operator-policy.test.ts, which deliberately uses the real table.
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

vi.mock('../mcp-client.js', () => ({ callMcpTool: vi.fn() }));

vi.mock('../approvals-store.js', () => ({
  createApproval: vi.fn(),
  checkTrust: vi.fn(),
}));

/**
 * The simulated future change: `write_file` is now something the operator may
 * call. Everything else keeps the real verdicts.
 */
vi.mock('../operator-policy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../operator-policy.js')>();
  return {
    ...actual,
    operatorPolicyFor: (name: string, args: unknown) =>
      name === 'write_file' ? 'allow' : actual.operatorPolicyFor(name, args),
    isOperatorToolAllowed: (name: string) =>
      name === 'write_file' ? true : actual.isOperatorToolAllowed(name),
  };
});

import * as storeModule from '../store.js';
import * as mcpClientModule from '../mcp-client.js';
import { operatorUserId } from '../operator-store.js';
import { runAgentTurn, type LoopEvent } from '../loop.js';

const mockAppendMessage = storeModule.appendMessage as MockedFunction<typeof storeModule.appendMessage>;
const mockListMessages = storeModule.listMessages as MockedFunction<typeof storeModule.listMessages>;
const mockGetRecentToolArgs = storeModule.getRecentToolArgs as MockedFunction<typeof storeModule.getRecentToolArgs>;
const mockGetConversation = storeModule.getConversation as MockedFunction<typeof storeModule.getConversation>;
const mockUpdateConversationTitle = storeModule.updateConversationTitle as MockedFunction<typeof storeModule.updateConversationTitle>;
const mockCallMcpTool = mcpClientModule.callMcpTool as MockedFunction<typeof mcpClientModule.callMcpTool>;

const ORG_ID = '11111111-1111-4111-8111-111111111111';
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
  let pass = 0;
  global.fetch = vi.fn(async () => {
    if (++pass === 1) {
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

beforeEach(() => {
  vi.clearAllMocks();
  mockAppendMessage.mockResolvedValue(stubMessage);
  mockListMessages.mockResolvedValue([]);
  mockGetRecentToolArgs.mockResolvedValue([]);
  mockGetConversation.mockResolvedValue(null);
  mockUpdateConversationTitle.mockResolvedValue(null);
  mockCallMcpTool.mockResolvedValue({ ok: true, result: { files: [] } } as never);
});

describe('operator — repoSync cannot reach the raw MCP client', () => {
  it('does not call manage_repo even when a workspace tool becomes allowlisted', async () => {
    // write_file → ensureHydrated → repoSync.pullLatest → mcp.call('manage_repo',
    // {action:'pull_latest'}) — and, because the app is touched, the end-of-turn
    // flush → repoSync.flush → mcp.call('manage_repo', {action:'push'}).
    // Both must be refused by the operator's policy-enforcing wrapper.
    oneToolCallThenStop('write_file', { app_id: 'app-1', path: 'index.ts', content: 'x' });

    await collect(
      runAgentTurn({
        conversationId: 'conv-op-raw',
        userId: operatorUserId(ORG_ID),
        jwt: 'operator-service-key',
        userMessage: 'Scheduled wake.',
        model: 'claude-sonnet-4-5',
        pool: stubPool,
        organizationId: ORG_ID,
      }),
    );

    const namesCalled = mockCallMcpTool.mock.calls.map((c) => c[0]);
    expect(namesCalled).not.toContain('manage_repo');
  });

  it('a HUMAN turn still reaches manage_repo through repoSync (no regression)', async () => {
    oneToolCallThenStop('write_file', { app_id: 'app-1', path: 'index.ts', content: 'x' });

    await collect(
      runAgentTurn({
        conversationId: 'conv-human',
        userId: 'cognito-sub-abc',
        jwt: 'user-jwt',
        userMessage: 'Write a file',
        model: 'claude-sonnet-4-5',
        pool: stubPool,
        organizationId: ORG_ID,
      }),
    );

    const namesCalled = mockCallMcpTool.mock.calls.map((c) => c[0]);
    expect(namesCalled).toContain('manage_repo');
  });

  it('honours an explicitly injected repoSync for an operator turn', async () => {
    // An injected repoSync is the caller's own object, never the raw default
    // client, so it is used as-is rather than silently replaced — otherwise
    // dependency injection would be broken for every future operator test.
    const injected = {
      pullLatest: vi.fn().mockResolvedValue({ hydrated: true }),
      pullSnapshot: vi.fn(),
      flush: vi.fn().mockResolvedValue({ newSnapshotId: null }),
      push: vi.fn(),
    };

    oneToolCallThenStop('write_file', { app_id: 'app-1', path: 'index.ts', content: 'x' });

    await collect(
      runAgentTurn(
        {
          conversationId: 'conv-op-injected',
          userId: operatorUserId(ORG_ID),
          jwt: 'operator-service-key',
          userMessage: 'Scheduled wake.',
          model: 'claude-sonnet-4-5',
          pool: stubPool,
          organizationId: ORG_ID,
        },
        { repoSync: injected as never },
      ),
    );

    expect(injected.pullLatest).toHaveBeenCalled();
    expect(injected.flush).toHaveBeenCalled();
    expect(mockCallMcpTool.mock.calls.map((c) => c[0])).not.toContain('manage_repo');
  });
});
