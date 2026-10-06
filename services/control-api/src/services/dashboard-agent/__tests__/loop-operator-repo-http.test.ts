/**
 * The loop must route an OPERATOR turn's repo I/O through `repo-http.ts`, and a
 * HUMAN turn's through the unchanged MCP `repo-sync.ts`.
 *
 * WHY THIS IS ITS OWN FILE. Asserting "the operator hydrates" requires the
 * operator to actually reach `ensureHydrated`, which means `write_file` has to
 * dispatch — and `write_file` sits at the 'approval' tier, so with the real
 * policy table the turn gates instead of writing. This file therefore mocks
 * the policy module to widen `write_file` to 'allow', exactly as
 * loop-operator-reposync.test.ts does and for the same reason. That mock is
 * module-wide, so it must not leak into the files that deliberately exercise
 * the real table (loop-operator-policy.test.ts, operator-cross-org.test.ts).
 *
 * WHAT IS AND IS NOT UNDER TEST HERE. The client's own behaviour — manifests,
 * presigns, the 404-vs-403 distinction, quota errors — is pinned by
 * repo-http.test.ts against a fake fetch. What this file pins is the WIRING:
 * which implementation each identity gets, that the operator's is built on the
 * shared working-tree cache, and that the operator's repo I/O no longer touches
 * `manage_repo`. Those are properties of loop.ts, and nothing in repo-http.ts
 * can establish them.
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

/** See the file header: `write_file` must dispatch for hydration to be reached. */
vi.mock('../operator-policy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../operator-policy.js')>();
  const widen = (name: string, args: unknown) =>
    name === 'write_file' ? ('allow' as const) : actual.operatorPolicyFor(name, args);
  return {
    ...actual,
    operatorPolicyFor: widen,
    operatorPolicyForOrg: (name: string, args: unknown, ownOrgId: string | null | undefined) =>
      actual.orgIdArgIsForeign(args, ownOrgId) ? ('deny' as const) : widen(name, args),
    isOperatorToolAllowed: (name: string) =>
      name === 'write_file' ? true : actual.isOperatorToolAllowed(name),
  };
});

const httpPullLatest = vi.fn();
const httpFlush = vi.fn();
const createHttpRepoSync = vi.fn(() => ({
  pullLatest: httpPullLatest,
  pullSnapshot: vi.fn(),
  flush: httpFlush,
  pushCurrentTree: vi.fn(),
}));
vi.mock('../repo-http.js', () => ({
  createHttpRepoSync: (...args: unknown[]) => createHttpRepoSync(...(args as [])),
}));

import * as storeModule from '../store.js';
import * as mcpClientModule from '../mcp-client.js';
import { operatorUserId } from '../operator-store.js';
import { runAgentTurn, getSharedWorkingTreeCache, type LoopEvent } from '../loop.js';

const mockAppendMessage = storeModule.appendMessage as MockedFunction<typeof storeModule.appendMessage>;
const mockListMessages = storeModule.listMessages as MockedFunction<typeof storeModule.listMessages>;
const mockGetRecentToolArgs = storeModule.getRecentToolArgs as MockedFunction<typeof storeModule.getRecentToolArgs>;
const mockGetConversation = storeModule.getConversation as MockedFunction<typeof storeModule.getConversation>;
const mockUpdateConversationTitle = storeModule.updateConversationTitle as MockedFunction<typeof storeModule.updateConversationTitle>;
const mockCallMcpTool = mcpClientModule.callMcpTool as MockedFunction<typeof mcpClientModule.callMcpTool>;

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const OPERATOR_KEY = 'bb_sk_operator_service_key';
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
  httpPullLatest.mockResolvedValue({ hydrated: true });
  httpFlush.mockResolvedValue({ pushed: 1, deleted: 0, newSnapshotId: null });
});

describe('operator turns use the HTTP repo path', () => {
  it('hydrates and flushes through repo-http, carrying the org service key', async () => {
    oneToolCallThenStop('write_file', { app_id: 'app-1', path: 'index.ts', content: 'x' });

    await collect(
      runAgentTurn({
        conversationId: 'conv-op-http',
        userId: operatorUserId(ORG_ID),
        jwt: OPERATOR_KEY,
        userMessage: 'Scheduled wake.',
        model: 'claude-sonnet-4-5',
        pool: stubPool,
        organizationId: ORG_ID,
      }),
    );

    expect(httpPullLatest).toHaveBeenCalledWith(
      expect.objectContaining({ appId: 'app-1', jwt: OPERATOR_KEY }),
    );
    // The end-of-turn flush is what actually PERSISTS the work. Without it the
    // operator writes into a cache that is discarded — the original bug.
    expect(httpFlush).toHaveBeenCalledWith(
      expect.objectContaining({ appId: 'app-1', jwt: OPERATOR_KEY }),
    );
  });

  it('builds the client on the SHARED working-tree cache', async () => {
    // A private cache would hydrate into one map and let file-ops write into
    // another, so every read-back and the flush diff would see an empty tree.
    oneToolCallThenStop('write_file', { app_id: 'app-1', path: 'index.ts', content: 'x' });

    await collect(
      runAgentTurn({
        conversationId: 'conv-op-cache',
        userId: operatorUserId(ORG_ID),
        jwt: OPERATOR_KEY,
        userMessage: 'Scheduled wake.',
        model: 'claude-sonnet-4-5',
        pool: stubPool,
        organizationId: ORG_ID,
      }),
    );

    expect(createHttpRepoSync).toHaveBeenCalledWith(
      expect.objectContaining({ cache: getSharedWorkingTreeCache() }),
    );
  });

  it('never reaches manage_repo on an operator turn', async () => {
    // The policy boundary is unchanged: manage_repo stays at 'approval' and
    // turnMcp still admits only 'allow'. The operator simply no longer needs it.
    oneToolCallThenStop('write_file', { app_id: 'app-1', path: 'index.ts', content: 'x' });

    await collect(
      runAgentTurn({
        conversationId: 'conv-op-no-mcp',
        userId: operatorUserId(ORG_ID),
        jwt: OPERATOR_KEY,
        userMessage: 'Scheduled wake.',
        model: 'claude-sonnet-4-5',
        pool: stubPool,
        organizationId: ORG_ID,
      }),
    );

    expect(mockCallMcpTool.mock.calls.map((c) => c[0])).not.toContain('manage_repo');
  });

  it('a hydration failure still degrades the turn rather than ending it', async () => {
    // Regression guard for the 2026-08-07 incident: a repo error thrown into
    // fileOps.execute() killed the turn on the FIRST write_file. The transport
    // changed; the swallow in ensureHydrated must not have.
    httpPullLatest.mockRejectedValue(new Error('repo GET failed (503)'));
    oneToolCallThenStop('write_file', { app_id: 'app-1', path: 'index.ts', content: 'x' });

    const events = await collect(
      runAgentTurn({
        conversationId: 'conv-op-degrade',
        userId: operatorUserId(ORG_ID),
        jwt: OPERATOR_KEY,
        userMessage: 'Scheduled wake.',
        model: 'claude-sonnet-4-5',
        pool: stubPool,
        organizationId: ORG_ID,
      }),
    );

    const errors = events.filter((e) => e.type === 'error');
    expect(errors, JSON.stringify(errors)).toHaveLength(0);
    expect(events.some((e) => e.type === 'tool_result')).toBe(true);
  });
});

describe('human turns are untouched', () => {
  it('still goes through MCP manage_repo and never constructs the HTTP client', async () => {
    oneToolCallThenStop('write_file', { app_id: 'app-1', path: 'index.ts', content: 'x' });

    await collect(
      runAgentTurn({
        conversationId: 'conv-human-http',
        userId: 'cognito-sub-abc',
        jwt: 'user-jwt',
        userMessage: 'Write a file',
        model: 'claude-sonnet-4-5',
        pool: stubPool,
        organizationId: ORG_ID,
      }),
    );

    expect(mockCallMcpTool.mock.calls.map((c) => c[0])).toContain('manage_repo');
    expect(createHttpRepoSync).not.toHaveBeenCalled();
  });
});

describe('an injected repoSync still wins', () => {
  it('is honoured on an operator turn instead of the HTTP client', async () => {
    // Dependency injection must keep working for every future operator test;
    // an injected object is the caller's own, never the raw default client.
    const injected = {
      pullLatest: vi.fn().mockResolvedValue({ hydrated: true }),
      pullSnapshot: vi.fn(),
      flush: vi.fn().mockResolvedValue({ newSnapshotId: null }),
      pushCurrentTree: vi.fn(),
    };
    oneToolCallThenStop('write_file', { app_id: 'app-1', path: 'index.ts', content: 'x' });

    await collect(
      runAgentTurn(
        {
          conversationId: 'conv-op-injected-http',
          userId: operatorUserId(ORG_ID),
          jwt: OPERATOR_KEY,
          userMessage: 'Scheduled wake.',
          model: 'claude-sonnet-4-5',
          pool: stubPool,
          organizationId: ORG_ID,
        },
        { repoSync: injected as never },
      ),
    );

    expect(injected.pullLatest).toHaveBeenCalled();
    expect(createHttpRepoSync).not.toHaveBeenCalled();
  });
});
