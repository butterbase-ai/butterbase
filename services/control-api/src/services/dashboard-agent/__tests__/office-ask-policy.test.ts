/**
 * Task 9 — an Office-origin foreground turn is governed by the Office
 * contract, and it bills its organization.
 *
 * Two properties are pinned here, and both are about where the truth lives.
 *
 * PROVENANCE. "Is this an Office conversation?" is read from the STORED
 * conversation row — never from a request body, a header, or a flag a caller
 * might forget to pass. That is the difference between a control and an
 * affordance: a route that forgot a flag would silently downgrade a customer
 * Office to the ordinary dashboard, and nobody would notice until a
 * deployment ran without its owner's approval.
 *
 * BILLING. An Office question is paid for by the Office's organization, not by
 * the personal organization the JWT happens to fall back to. The gateway
 * decides that from `x-organization-id`, so an Office turn must send it — and
 * an ordinary dashboard conversation must NOT, because the dashboard
 * assistant is its own product surface and its billing must not move.
 *
 * The classifier itself is covered exhaustively in office-tool-policy.test.ts;
 * these tests cover the WIRING into the loop.
 */

import { describe, it, expect, vi, beforeEach, afterAll, type MockedFunction } from 'vitest';
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
}));

vi.mock('../tool-catalog.js', async () => {
  const actual = await vi.importActual<typeof import('../tool-catalog.js')>('../tool-catalog.js');
  return {
    ...actual,
    getToolCatalog: vi.fn().mockReturnValue([
      {
        name: 'manage_app',
        description: 'Manage app lifecycle',
        parameters: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] },
      },
      {
        name: 'write_file',
        description: 'write file',
        parameters: { type: 'object', additionalProperties: true, required: ['app_id', 'path', 'content'] },
      },
      {
        name: 'deploy_frontend',
        description: 'deploy',
        parameters: { type: 'object', additionalProperties: true, required: ['app_id'] },
      },
    ]),
    isFileOpTool: (name: string) => name === 'write_file',
    isDeployTool: (name: string) => name === 'deploy_frontend',
    isDeployFunctionTool: () => false,
    // Deliberately 'safe' for manage_app update_env: the ordinary human
    // sensitivity gate would NOT pause on it, so a pause can only come from the
    // Office floor. That is what makes these tests discriminate.
    sensitivityFor: () => 'safe',
  };
});

import * as storeModule from '../store.js';
import * as mcpClientModule from '../mcp-client.js';
import * as approvalsStoreModule from '../approvals-store.js';
import { runAgentTurn, streamChatCompletion, type LoopEvent } from '../loop.js';
import {
  setOperatorAccessPolicy,
  type OperatorAccessInput,
} from '../operator-access-policy.js';

const mockAppendMessage = storeModule.appendMessage as MockedFunction<typeof storeModule.appendMessage>;
const mockListMessages = storeModule.listMessages as MockedFunction<typeof storeModule.listMessages>;
const mockGetRecentToolArgs = storeModule.getRecentToolArgs as MockedFunction<typeof storeModule.getRecentToolArgs>;
const mockUpsertSnapshotLabel = storeModule.upsertSnapshotLabel as MockedFunction<typeof storeModule.upsertSnapshotLabel>;
const mockGetConversation = storeModule.getConversation as MockedFunction<typeof storeModule.getConversation>;
const mockCallMcpTool = mcpClientModule.callMcpTool as MockedFunction<typeof mcpClientModule.callMcpTool>;
const mockCreateApproval = approvalsStoreModule.createApproval as MockedFunction<typeof approvalsStoreModule.createApproval>;

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';

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

const baseInput = {
  conversationId: 'conv-1',
  userId: 'user-1',
  jwt: 'test-jwt',
  userMessage: 'Do the thing',
  model: 'claude-3-5-sonnet',
  pool: stubPool,
};

/** The stored row the loop reads to decide provenance. */
function conversation(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'conv-1',
    userId: 'user-1',
    title: 'Asked in Office',
    model: 'claude-3-5-sonnet',
    organizationId: ORG,
    origin: 'office' as const,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastMessageAt: null,
    pinnedAt: null,
    ...overrides,
  } as any;
}

function makeSseStream(deltas: object[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const lines =
    deltas.map((d) => `data: ${JSON.stringify(d)}\n\n`).join('') + 'data: [DONE]\n\n';
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

/** One assistant turn that calls a tool with the given args, then stops. */
function toolCallPass(name: string, args: Record<string, unknown>) {
  return gatewayResponse([
    {
      choices: [
        {
          delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name, arguments: '' } }] },
          finish_reason: null,
        },
      ],
    },
    {
      choices: [
        { delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] }, finish_reason: null },
      ],
    },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ]);
}

async function collect(gen: AsyncGenerator<LoopEvent>): Promise<LoopEvent[]> {
  const events: LoopEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

/** Header lookup that does not depend on the casing a caller chose. */
function header(init: any, name: string): unknown {
  const headers = (init?.headers ?? {}) as Record<string, unknown>;
  const wanted = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === wanted) return v;
  }
  return undefined;
}

const POLICY_CALLS: OperatorAccessInput[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  POLICY_CALLS.length = 0;
  mockAppendMessage.mockResolvedValue(stubMessage);
  mockListMessages.mockResolvedValue([]);
  mockGetRecentToolArgs.mockResolvedValue([]);
  mockUpsertSnapshotLabel.mockResolvedValue(undefined);
  mockGetConversation.mockResolvedValue(null);
  mockCreateApproval.mockResolvedValue({
    id: 'approval-1',
    conversationId: 'conv-1',
    turnMessageId: 'msg-append-1',
    toolName: 'manage_app',
    toolArgs: {},
    sensitivity: 'destructive',
    status: 'pending',
    trustScope: null,
    denyReason: null,
    createdAt: '',
    resolvedAt: null,
    resolvedBy: null,
    traceId: null,
    resumedAt: null,
    approvedOperation: null,
  } as any);
  setOperatorAccessPolicy({
    async evaluate(input) {
      POLICY_CALLS.push(input);
      return { allowed: true, reason: null, approvalMode: 'consequential' };
    },
  });
});

afterAll(() => {
  setOperatorAccessPolicy(null);
});

describe('an Office-origin conversation is governed by the Office floor', () => {
  it('pauses a live change for a human and records the immutable operation', async () => {
    mockGetConversation.mockResolvedValue(conversation());
    global.fetch = vi.fn().mockResolvedValueOnce(
      toolCallPass('manage_app', { action: 'update_env', app_id: 'app-1', KEY: 'v' }),
    );

    const events = await collect(runAgentTurn(baseInput));

    expect(events).toContainEqual({
      type: 'approval_required',
      approval_id: 'approval-1',
      tool_name: 'manage_app',
      args: { action: 'update_env', app_id: 'app-1', KEY: 'v' },
      sensitivity: 'destructive',
    });
    expect(mockCreateApproval).toHaveBeenCalledTimes(1);
    // The server-owned operation is captured on EVERY office-origin gate, not
    // only for deployments — a legacy row with no operation must be
    // re-proposed, so new rows must always have one.
    expect(mockCreateApproval.mock.calls[0][1].approvedOperation).toMatchObject({
      version: 1,
      toolName: 'manage_app',
      args: { action: 'update_env', app_id: 'app-1', KEY: 'v' },
    });
    // Nothing ran.
    expect(mockCallMcpTool).not.toHaveBeenCalled();
  });

  it('lets preparation run without a human', async () => {
    mockGetConversation.mockResolvedValue(conversation());
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(toolCallPass('manage_app', { action: 'list' }))
      .mockResolvedValueOnce(
        gatewayResponse([{ choices: [{ delta: { content: 'Done.' }, finish_reason: 'stop' }] }]),
      );
    mockCallMcpTool.mockResolvedValueOnce({ ok: true, result: { apps: [] } });

    const events = await collect(runAgentTurn(baseInput));

    expect(events.some((e) => e.type === 'approval_required')).toBe(false);
    expect(mockCreateApproval).not.toHaveBeenCalled();
    expect(mockCallMcpTool).toHaveBeenCalledTimes(1);
  });

  it('threads the conversation organization into tool calls', async () => {
    mockGetConversation.mockResolvedValue(conversation());
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(toolCallPass('manage_app', { action: 'list' }))
      .mockResolvedValueOnce(
        gatewayResponse([{ choices: [{ delta: { content: 'Done.' }, finish_reason: 'stop' }] }]),
      );
    mockCallMcpTool.mockResolvedValueOnce({ ok: true, result: { apps: [] } });

    await collect(runAgentTurn(baseInput));

    // Fourth argument: the tool transport must target the Office's org, the
    // same way the gateway does. A member's JWT may carry a different
    // personal-org fallback.
    expect(mockCallMcpTool.mock.calls[0].slice(0, 4)).toEqual([
      'manage_app',
      { action: 'list' },
      'test-jwt',
      ORG,
    ]);
  });

  it('blocks the turn before any model spend when the organization loses access', async () => {
    mockGetConversation.mockResolvedValue(conversation());
    setOperatorAccessPolicy({
      async evaluate(input) {
        POLICY_CALLS.push(input);
        return { allowed: false, reason: 'paid_plan_required', approvalMode: 'consequential' };
      },
    });
    const fetchMock = vi.fn();
    global.fetch = fetchMock;

    const events = await collect(runAgentTurn(baseInput));

    expect(events).toContainEqual({ type: 'blocked', reason: 'paid_plan_required' });
    expect(fetchMock).not.toHaveBeenCalled();
    // The user's message is still persisted — the block is about spend, and
    // losing it would lose the question the customer already asked.
    expect(mockAppendMessage).toHaveBeenNthCalledWith(
      1, stubPool, 'conv-1', expect.objectContaining({ role: 'user', content: 'Do the thing' }),
    );
  });

  it('fails the turn closed when the stored provenance cannot be read', async () => {
    // A conversation row is the ONLY evidence that this is an Office turn. If
    // that read fails, proceeding as an ordinary dashboard turn would drop the
    // Office floor, the organization-scoped tools and the organization's
    // billing — a fail-open downgrade. The turn must stop instead.
    mockGetConversation.mockRejectedValueOnce(new Error('database unavailable'));
    const fetchMock = vi.fn();
    global.fetch = fetchMock;

    await expect(collect(runAgentTurn(baseInput))).rejects.toThrow('database unavailable');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(POLICY_CALLS).toEqual([]);
  });
});

describe('an ordinary dashboard conversation is unchanged', () => {
  it('does not consult the Office access policy, gate with the Office floor, or send an org header', async () => {
    mockGetConversation.mockResolvedValue(null); // no stored Office provenance
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(toolCallPass('manage_app', { action: 'update_env', app_id: 'app-1' }))
      .mockResolvedValueOnce(
        gatewayResponse([{ choices: [{ delta: { content: 'Done.' }, finish_reason: 'stop' }] }]),
      );
    mockCallMcpTool.mockResolvedValueOnce({ ok: true, result: { ok: true } });

    const events = await collect(runAgentTurn(baseInput));

    // The same call that is gated for Office runs here — no office floor, and
    // no ordinary sensitivity gate either (the mock's sensitivityFor is safe).
    expect(events.some((e) => e.type === 'approval_required')).toBe(false);
    expect(mockCreateApproval).not.toHaveBeenCalled();
    expect(POLICY_CALLS).toEqual([]);

    const init = (global.fetch as any).mock.calls[0][1];
    expect(header(init, 'x-organization-id')).toBeUndefined();
    // And the tool transport carries no organization — this is the pre-Task-9
    // dashboard behaviour, unchanged.
    expect(mockCallMcpTool.mock.calls[0][3]).toBeUndefined();
  });

  it('does not apply the Office floor when the stored row says dashboard', async () => {
    mockGetConversation.mockResolvedValue(conversation({ origin: 'dashboard', organizationId: null }));
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(toolCallPass('manage_app', { action: 'update_env', app_id: 'app-1' }))
      .mockResolvedValueOnce(
        gatewayResponse([{ choices: [{ delta: { content: 'Done.' }, finish_reason: 'stop' }] }]),
      );
    mockCallMcpTool.mockResolvedValueOnce({ ok: true, result: { ok: true } });

    const events = await collect(runAgentTurn(baseInput));

    expect(events.some((e) => e.type === 'approval_required')).toBe(false);
    expect(POLICY_CALLS).toEqual([]);
  });
});

describe('gateway request attribution', () => {
  it('sends the Office organization as x-organization-id', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      gatewayResponse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]),
    );

    for await (const _chunk of streamChatCompletion({
      model: 'm', messages: [], tools: [], jwt: 'j', organizationId: ORG,
    })) { /* drain */ }

    const init = (global.fetch as any).mock.calls[0][1];
    expect(header(init, 'x-organization-id')).toBe(ORG);
  });

  it('omits the header when no organization is bound', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      gatewayResponse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]),
    );

    for await (const _chunk of streamChatCompletion({
      model: 'm', messages: [], tools: [], jwt: 'j',
    })) { /* drain */ }

    const init = (global.fetch as any).mock.calls[0][1];
    expect(header(init, 'x-organization-id')).toBeUndefined();
  });

  it('never bills a different organization than the stored one', async () => {
    mockGetConversation.mockResolvedValue(conversation());
    global.fetch = vi.fn().mockResolvedValueOnce(
      gatewayResponse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]),
    );

    await collect(runAgentTurn({ ...baseInput, organizationId: OTHER_ORG }));

    const init = (global.fetch as any).mock.calls[0][1];
    expect(header(init, 'x-organization-id')).toBe(ORG);
  });
});
