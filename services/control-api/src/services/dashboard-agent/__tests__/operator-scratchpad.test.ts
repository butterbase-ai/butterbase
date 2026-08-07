/**
 * The operator's agent-authored working memory (`update_operator_scratchpad`)
 * and its interaction with the loop.
 *
 * Deliberately a SEPARATE file from loop.test.ts, which cannot be run in this
 * environment (pre-existing JS heap OOM, reproduced at branch base). Modelled
 * on loop-operator-policy.test.ts: the REAL tool-catalog.ts and
 * operator-policy.ts are used, because a test of what the operator may call
 * must not run against a hand-written copy of the table it is testing.
 *
 * The scratchpad is model-written. Nothing here — and nothing anywhere —
 * should ever make it an input to a security decision; the tests below pin the
 * one property that keeps that true on the write side, namely that the TARGET
 * ORG comes from the operator sentinel and never from tool arguments.
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
  stripJsonbNulls: (x: unknown) => x,
}));

vi.mock('../mcp-client.js', () => ({ callMcpTool: vi.fn() }));

vi.mock('../approvals-store.js', () => ({
  createApproval: vi.fn(),
  checkTrust: vi.fn(),
}));

vi.mock('../operator-scratchpad-store.js', async () => {
  const actual = await vi.importActual<typeof import('../operator-scratchpad-store.js')>(
    '../operator-scratchpad-store.js',
  );
  return { ...actual, setOperatorScratchpad: vi.fn(), getOperatorScratchpad: vi.fn() };
});

import * as storeModule from '../store.js';
import * as mcpClientModule from '../mcp-client.js';
import * as approvalsStoreModule from '../approvals-store.js';
import * as scratchpadModule from '../operator-scratchpad-store.js';
import { OPERATOR_SCRATCHPAD_MAX_CHARS } from '../operator-scratchpad-store.js';
import {
  getToolCatalog,
  OPERATOR_SCRATCHPAD_TOOL,
  isOperatorScratchpadTool,
} from '../tool-catalog.js';
import { getSystemPrompt } from '../prompt.js';
import { operatorUserId } from '../operator-store.js';
import {
  OPERATOR_TOOL_TIERS,
  OPERATOR_LOCAL_TOOLS,
  operatorPolicyFor,
  operatorPolicyForOrg,
  principalMayExecute,
} from '../operator-policy.js';
import { runAgentTurn, type LoopEvent } from '../loop.js';

const mockAppendMessage = storeModule.appendMessage as MockedFunction<typeof storeModule.appendMessage>;
const mockListMessages = storeModule.listMessages as MockedFunction<typeof storeModule.listMessages>;
const mockGetRecentToolArgs = storeModule.getRecentToolArgs as MockedFunction<typeof storeModule.getRecentToolArgs>;
const mockGetConversation = storeModule.getConversation as MockedFunction<typeof storeModule.getConversation>;
const mockUpdateConversationTitle = storeModule.updateConversationTitle as MockedFunction<typeof storeModule.updateConversationTitle>;
const mockCallMcpTool = mcpClientModule.callMcpTool as MockedFunction<typeof mcpClientModule.callMcpTool>;
const mockCreateApproval = approvalsStoreModule.createApproval as MockedFunction<typeof approvalsStoreModule.createApproval>;
const mockCheckTrust = approvalsStoreModule.checkTrust as MockedFunction<typeof approvalsStoreModule.checkTrust>;
const mockSetScratchpad = scratchpadModule.setOperatorScratchpad as MockedFunction<typeof scratchpadModule.setOperatorScratchpad>;

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
const OPERATOR_USER = operatorUserId(ORG_ID);
const HUMAN_USER = 'cognito-sub-abc';

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

function noToolCalls() {
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

function toolNamesSent(body: string): string[] {
  const parsed = JSON.parse(body) as { tools?: Array<{ function?: { name?: string }; name?: string }> };
  return (parsed.tools ?? []).map((t) => t.function?.name ?? t.name ?? '');
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

function humanInput(overrides: Record<string, unknown> = {}) {
  return {
    conversationId: 'conv-1',
    userId: HUMAN_USER,
    jwt: 'user-jwt',
    userMessage: 'Hello',
    model: 'claude-sonnet-4-5',
    pool: stubPool,
    organizationId: ORG_ID,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAppendMessage.mockResolvedValue(stubMessage);
  mockListMessages.mockResolvedValue([]);
  mockGetRecentToolArgs.mockResolvedValue([]);
  mockGetConversation.mockResolvedValue(null);
  mockUpdateConversationTitle.mockResolvedValue(null);
  mockCheckTrust.mockResolvedValue(false);
  mockCallMcpTool.mockResolvedValue({ ok: true, result: { content: [{ type: 'text', text: '{}' }] } } as never);
  mockSetScratchpad.mockResolvedValue({
    organizationId: ORG_ID,
    content: 'saved',
    updatedAt: '2026-08-06T00:00:00.000Z',
  });
});

// ---------------------------------------------------------------------------
// Catalog + policy wiring
// ---------------------------------------------------------------------------

describe('scratchpad tool — catalog and policy table', () => {
  it('is in the shared catalog exactly once, marked operator-only', () => {
    const specs = getToolCatalog().filter((t) => t.name === OPERATOR_SCRATCHPAD_TOOL);
    expect(specs).toHaveLength(1);
    expect(specs[0].operatorOnly).toBe(true);
    expect(isOperatorScratchpadTool(OPERATOR_SCRATCHPAD_TOOL)).toBe(true);
  });

  it('has a deliberate verdict in the operator policy table: allow', () => {
    expect(OPERATOR_TOOL_TIERS.get(OPERATOR_SCRATCHPAD_TOOL)).toBe('allow');
    expect(operatorPolicyFor(OPERATOR_SCRATCHPAD_TOOL, { content: 'x' })).toBe('allow');
  });

  it('tells the model substrate is the source of truth, not the scratchpad', () => {
    const spec = getToolCatalog().find((t) => t.name === OPERATOR_SCRATCHPAD_TOOL)!;
    expect(spec.description).toMatch(/substrate/i);
    expect(spec.description).toMatch(/source of truth/i);
    // and that the cap rejects rather than truncates
    expect(spec.description).toContain(String(OPERATOR_SCRATCHPAD_MAX_CHARS));
    expect(spec.description).toMatch(/REJECTED/);
  });

  it('is a LOCAL tool: not reachable through the approval-replay path', () => {
    // executeOnce ends in callMcpTool and no MCP tool answers to this name.
    expect(OPERATOR_LOCAL_TOOLS.has(OPERATOR_SCRATCHPAD_TOOL)).toBe(true);
    expect(principalMayExecute('operator', OPERATOR_SCRATCHPAD_TOOL, { content: 'x' })).toBe(false);
    expect(principalMayExecute('human', OPERATOR_SCRATCHPAD_TOOL, { content: 'x' })).toBe(false);
  });

  it('is still subject to the cross-org guard, which was NOT weakened', () => {
    expect(operatorPolicyForOrg(OPERATOR_SCRATCHPAD_TOOL, { content: 'x', org_id: OTHER_ORG }, ORG_ID)).toBe('deny');
  });
});

// ---------------------------------------------------------------------------
// The human assistant is unaffected
// ---------------------------------------------------------------------------

describe('human assistant — unchanged', () => {
  it('is never offered the operator-only tool', async () => {
    const { bodies } = noToolCalls();
    await collect(runAgentTurn(humanInput()));
    expect(toolNamesSent(bodies[0])).not.toContain(OPERATOR_SCRATCHPAD_TOOL);
  });

  it('is offered exactly the catalog minus operator-only specs', async () => {
    const { bodies } = noToolCalls();
    await collect(runAgentTurn(humanInput()));
    const expected = getToolCatalog().filter((t) => t.operatorOnly !== true).map((t) => t.name);
    expect(toolNamesSent(bodies[0])).toEqual(expected);
    // Sanity: the filter actually removed something, so this is not vacuous.
    // Not hardcoded to "- 1": the operator-only count grew to 2 with
    // `run_sandbox_code` (see tool-catalog.ts), and this assertion should
    // track that count rather than assume the scratchpad tool is the only one.
    const operatorOnlyCount = getToolCatalog().filter((t) => t.operatorOnly === true).length;
    expect(operatorOnlyCount).toBeGreaterThanOrEqual(2);
    expect(expected.length).toBe(getToolCatalog().length - operatorOnlyCount);
  });

  it('sends a byte-identical system prompt', async () => {
    const { bodies } = noToolCalls();
    await collect(runAgentTurn(humanInput()));
    const parsed = JSON.parse(bodies[0]) as { messages: Array<{ role: string; content: string }> };
    const system = parsed.messages.find((m) => m.role === 'system')!;
    // No schema block is injected (getRecentToolArgs is empty), so the system
    // message is the prompt verbatim — nothing operator-related was appended.
    expect(system.content).toBe(getSystemPrompt());
    expect(system.content).not.toContain(OPERATOR_SCRATCHPAD_TOOL);
    expect(system.content).not.toMatch(/scratchpad/i);
  });

  it('cannot dispatch the tool even if the model names it anyway', async () => {
    oneToolCallThenStop(OPERATOR_SCRATCHPAD_TOOL, { content: 'sneaky' });
    const events = await collect(runAgentTurn(humanInput()));
    expect(mockSetScratchpad).not.toHaveBeenCalled();
    const result = events.find((e) => e.type === 'tool_result') as
      | Extract<LoopEvent, { type: 'tool_result' }>
      | undefined;
    expect(result!.error).toContain('not available in this agent\'s catalog');
  });
});

// ---------------------------------------------------------------------------
// The operator's write path
// ---------------------------------------------------------------------------

describe('operator — update_operator_scratchpad', () => {
  it('is offered to the operator', async () => {
    const { bodies } = noToolCalls();
    await collect(runAgentTurn(operatorInput()));
    expect(toolNamesSent(bodies[0])).toContain(OPERATOR_SCRATCHPAD_TOOL);
  });

  it('writes the content, in-process, without touching MCP', async () => {
    oneToolCallThenStop(OPERATOR_SCRATCHPAD_TOOL, { content: 'open thread: invoice 42' });

    const events = await collect(runAgentTurn(operatorInput()));

    expect(mockSetScratchpad).toHaveBeenCalledTimes(1);
    expect(mockSetScratchpad).toHaveBeenCalledWith(stubPool, ORG_ID, 'open thread: invoice 42');
    expect(mockCallMcpTool).not.toHaveBeenCalled();

    const result = events.find((e) => e.type === 'tool_result') as
      | Extract<LoopEvent, { type: 'tool_result' }>
      | undefined;
    expect(result!.error).toBeUndefined();
    expect(result!.result).toMatchObject({ ok: true });
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  it('writes ONLY its own org — a model-supplied org_id cannot redirect it', async () => {
    oneToolCallThenStop(OPERATOR_SCRATCHPAD_TOOL, { content: 'x', org_id: OTHER_ORG });

    const events = await collect(runAgentTurn(operatorInput()));

    // The cross-org guard refuses the call outright; nothing is written at all,
    // and in particular nothing is written for OTHER_ORG.
    expect(mockSetScratchpad).not.toHaveBeenCalled();
    const result = events.find((e) => e.type === 'tool_result') as
      | Extract<LoopEvent, { type: 'tool_result' }>
      | undefined;
    expect(result!.error).toContain('not permitted for the autonomous operator');
  });

  it('takes the org from the operator sentinel, not from `organizationId`', async () => {
    // If the write ever read the (caller-supplied, optional) `organizationId`
    // instead of the sentinel identity, this would write OTHER_ORG.
    oneToolCallThenStop(OPERATOR_SCRATCHPAD_TOOL, { content: 'x' });

    await collect(runAgentTurn(operatorInput({ organizationId: OTHER_ORG })));

    expect(mockSetScratchpad).toHaveBeenCalledWith(stubPool, ORG_ID, 'x');
  });

  it('rejects a non-string content as an ordinary tool error', async () => {
    oneToolCallThenStop(OPERATOR_SCRATCHPAD_TOOL, { content: 12345 });

    const events = await collect(runAgentTurn(operatorInput()));

    expect(mockSetScratchpad).not.toHaveBeenCalled();
    const result = events.find((e) => e.type === 'tool_result') as
      | Extract<LoopEvent, { type: 'tool_result' }>
      | undefined;
    expect(result!.error).toContain('requires a string "content" argument');
  });

  it('surfaces an over-cap rejection to the model instead of truncating', async () => {
    const tooLong = 'a'.repeat(OPERATOR_SCRATCHPAD_MAX_CHARS + 1);
    mockSetScratchpad.mockRejectedValue(
      new Error(`operator scratchpad content exceeds ${OPERATOR_SCRATCHPAD_MAX_CHARS} characters (got ${tooLong.length})`),
    );
    oneToolCallThenStop(OPERATOR_SCRATCHPAD_TOOL, { content: tooLong });

    const events = await collect(runAgentTurn(operatorInput()));

    // The full string was offered to the store — the loop does not pre-trim.
    expect(mockSetScratchpad).toHaveBeenCalledWith(stubPool, ORG_ID, tooLong);
    const result = events.find((e) => e.type === 'tool_result') as
      | Extract<LoopEvent, { type: 'tool_result' }>
      | undefined;
    expect(result!.error).toContain('exceeds 8000 characters');
    expect(result!.result).toBeUndefined();
    // A rejected write does not kill the turn.
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });

  it('answers the assistant tool_call with a tool row, even on failure', async () => {
    mockSetScratchpad.mockRejectedValue(new Error('boom'));
    oneToolCallThenStop(OPERATOR_SCRATCHPAD_TOOL, { content: 'x' });

    await collect(runAgentTurn(operatorInput()));

    // A history ending in an unanswered tool_call wedges the org's one
    // operator conversation permanently (see resume.ts).
    expect(mockAppendMessage).toHaveBeenCalledWith(
      stubPool,
      'conv-1',
      expect.objectContaining({
        role: 'tool',
        toolCallId: 'call-1',
        toolName: OPERATOR_SCRATCHPAD_TOOL,
        toolResult: { error: 'boom' },
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// The store's own cap enforcement (real implementation, no DB)
// ---------------------------------------------------------------------------

describe('setOperatorScratchpad — cap', () => {
  it('rejects past the cap without issuing a query', async () => {
    const actual = await vi.importActual<typeof import('../operator-scratchpad-store.js')>(
      '../operator-scratchpad-store.js',
    );
    const query = vi.fn();
    const pool = { query } as unknown as pg.Pool;

    await expect(
      actual.setOperatorScratchpad(pool, ORG_ID, 'a'.repeat(OPERATOR_SCRATCHPAD_MAX_CHARS + 1)),
    ).rejects.toThrow(/exceeds 8000 characters/);
    expect(query).not.toHaveBeenCalled();
  });

  it('accepts content exactly at the cap', async () => {
    const actual = await vi.importActual<typeof import('../operator-scratchpad-store.js')>(
      '../operator-scratchpad-store.js',
    );
    const content = 'a'.repeat(OPERATOR_SCRATCHPAD_MAX_CHARS);
    const query = vi.fn().mockResolvedValue({
      rows: [{ organization_id: ORG_ID, content, updated_at: 'now' }],
    });
    const pool = { query } as unknown as pg.Pool;

    const saved = await actual.setOperatorScratchpad(pool, ORG_ID, content);
    expect(saved.content).toHaveLength(OPERATOR_SCRATCHPAD_MAX_CHARS);
    // The org is a bound parameter, never interpolated.
    expect(query.mock.calls[0][1]).toEqual([ORG_ID, content]);
  });
});
