/**
 * C3 — operator policy enforcement inside runAgentTurn.
 *
 * These tests pin the claim the whole autonomous-operator design rests on:
 * "the bridge, not the sandbox, decides which tools may be called."
 *
 * Deliberately a SEPARATE file from loop.test.ts, which cannot be run in this
 * environment (pre-existing JS heap OOM, reproduced at branch base).
 *
 * Deliberately uses the REAL tool-catalog.ts, operator-policy.ts and
 * operator-store.ts. loop.test.ts mocks the catalog and re-implements
 * sensitivityFor inline; a test of a security control must not be run against a
 * hand-written copy of the table it is testing. Only I/O is mocked.
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
}));

import * as storeModule from '../store.js';
import * as mcpClientModule from '../mcp-client.js';
import * as approvalsStoreModule from '../approvals-store.js';
import { getToolCatalog, OPERATOR_SANDBOX_CODE_TOOL } from '../tool-catalog.js';
import { operatorUserId } from '../operator-store.js';
import { isOperatorToolAllowed } from '../operator-policy.js';
import { runAgentTurn, type LoopEvent } from '../loop.js';

const mockAppendMessage = storeModule.appendMessage as MockedFunction<typeof storeModule.appendMessage>;
const mockListMessages = storeModule.listMessages as MockedFunction<typeof storeModule.listMessages>;
const mockGetRecentToolArgs = storeModule.getRecentToolArgs as MockedFunction<typeof storeModule.getRecentToolArgs>;
const mockGetConversation = storeModule.getConversation as MockedFunction<typeof storeModule.getConversation>;
const mockUpdateConversationTitle = storeModule.updateConversationTitle as MockedFunction<typeof storeModule.updateConversationTitle>;
const mockCallMcpTool = mcpClientModule.callMcpTool as MockedFunction<typeof mcpClientModule.callMcpTool>;
const mockCreateApproval = approvalsStoreModule.createApproval as MockedFunction<typeof approvalsStoreModule.createApproval>;
const mockCheckTrust = approvalsStoreModule.checkTrust as MockedFunction<typeof approvalsStoreModule.checkTrust>;

const ORG_ID = '11111111-1111-4111-8111-111111111111';
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

/** One gateway pass that emits a single tool call, then a pass that stops. */
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

/** Tool names the gateway was offered on the first pass. */
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
  mockCreateApproval.mockResolvedValue({
    id: 'approval-1',
    conversationId: 'conv-1',
    turnMessageId: 'msg-1',
    toolName: 'x',
    toolArgs: {},
    sensitivity: 'destructive',
    status: 'pending',
    trustScope: null,
    denyReason: null,
    createdAt: 'now',
    resolvedAt: null,
  } as never);
});

// ---------------------------------------------------------------------------
// deny
// ---------------------------------------------------------------------------

describe('operator — deny verdict', () => {
  // The headline defect: an unattended operator holding an org service key
  // could call ~33 tools with no gate of any kind.
  it.each([
    ['manage_api_keys', { action: 'create' }],
    ['manage_auth_users', { action: 'delete' }],
    ['deploy_function', { action: 'deploy' }],
    ['manage_rls', { action: 'disable' }],
    ['seed_database', { action: 'seed' }],
    ['write_file', { app_id: 'a', path: 'p', content: 'c' }],
  ])('does NOT dispatch %s, and returns the refusal as a tool result', async (name, args) => {
    oneToolCallThenStop(name, args);

    const events = await collect(runAgentTurn(operatorInput()));

    // The control: nothing was dispatched.
    expect(mockCallMcpTool).not.toHaveBeenCalled();

    // The model sees an ordinary tool error and can adapt — the turn is not
    // killed and no error frame is emitted.
    const result = events.find((e) => e.type === 'tool_result') as
      | Extract<LoopEvent, { type: 'tool_result' }>
      | undefined;
    expect(result).toBeDefined();
    expect(result!.error).toContain('not permitted for the autonomous operator');
    expect(result!.result).toBeUndefined();
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events.some((e) => e.type === 'done')).toBe(true);

    // No approval was created — a denied tool is not gateable.
    expect(mockCreateApproval).not.toHaveBeenCalled();

    // The refusal is persisted as the tool row answering the assistant's
    // tool_call, so the history never ends in an unanswered tool_call.
    expect(mockAppendMessage).toHaveBeenCalledWith(
      stubPool,
      'conv-1',
      expect.objectContaining({
        role: 'tool',
        toolCallId: 'call-1',
        toolName: name,
        toolResult: { error: expect.stringContaining('not permitted') },
      }),
    );
  });

  it('refuses a tool name the model invented that is in NO catalog', async () => {
    // The catalog filter is only an affordance. A hallucinated name was never
    // in any list, so only the dispatch-site check can refuse it.
    oneToolCallThenStop('exfiltrate_everything', { target: 'evil.example' });

    const events = await collect(runAgentTurn(operatorInput()));

    expect(mockCallMcpTool).not.toHaveBeenCalled();
    const result = events.find((e) => e.type === 'tool_result') as
      | Extract<LoopEvent, { type: 'tool_result' }>
      | undefined;
    expect(result!.error).toContain('not permitted for the autonomous operator');
  });

  it('refuses a DENIED manage_substrate action (approve — agent self-approval)', async () => {
    // Never "fix" this by removing `approve` from OPERATOR_DENIED_SUBSTRATE_ACTIONS.
    oneToolCallThenStop('manage_substrate', { action: 'approve', action_id: 'act-1' });

    const events = await collect(runAgentTurn(operatorInput()));

    expect(mockCallMcpTool).not.toHaveBeenCalled();
    expect(mockCreateApproval).not.toHaveBeenCalled();
    const result = events.find((e) => e.type === 'tool_result') as
      | Extract<LoopEvent, { type: 'tool_result' }>
      | undefined;
    expect(result!.error).toContain('not permitted for the autonomous operator');
  });
});

// ---------------------------------------------------------------------------
// approval
// ---------------------------------------------------------------------------

describe('operator — approval verdict', () => {
  it('pauses the turn and creates an approval instead of executing (delete_rule)', async () => {
    oneToolCallThenStop('manage_substrate', { action: 'delete_rule', rule_id: 'r-1' });

    const events = await collect(runAgentTurn(operatorInput()));

    expect(mockCallMcpTool).not.toHaveBeenCalled();
    expect(mockCreateApproval).toHaveBeenCalledTimes(1);
    expect(mockCreateApproval).toHaveBeenCalledWith(
      stubPool,
      expect.objectContaining({
        conversationId: 'conv-1',
        toolName: 'manage_substrate',
        toolArgs: { action: 'delete_rule', rule_id: 'r-1' },
        sensitivity: 'destructive',
      }),
    );

    const approvalEvent = events.find((e) => e.type === 'approval_required');
    expect(approvalEvent).toEqual({
      type: 'approval_required',
      approval_id: 'approval-1',
      tool_name: 'manage_substrate',
      args: { action: 'delete_rule', rule_id: 'r-1' },
      sensitivity: 'destructive',
    });

    // Turn is paused, not completed.
    expect(events.some((e) => e.type === 'done')).toBe(false);

    // The assistant row carries the pending approval id so resume can find it.
    expect(mockAppendMessage).toHaveBeenCalledWith(
      stubPool,
      'conv-1',
      expect.objectContaining({ role: 'assistant', pendingApprovalId: 'approval-1' }),
      expect.any(String),
    );
  });

  it('pauses on a propose of an approval_required substrate capability', async () => {
    oneToolCallThenStop('manage_substrate', { action: 'propose', capability: 'send_email_draft' });

    const events = await collect(runAgentTurn(operatorInput()));

    expect(mockCallMcpTool).not.toHaveBeenCalled();
    expect(mockCreateApproval).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.type === 'approval_required')).toBe(true);
  });

  it('does NOT consult checkTrust for an operator (one conversation per org => permanent trust)', async () => {
    mockCheckTrust.mockResolvedValue(true);
    oneToolCallThenStop('manage_substrate', { action: 'delete_rule', rule_id: 'r-1' });

    await collect(runAgentTurn(operatorInput()));

    expect(mockCheckTrust).not.toHaveBeenCalled();
    expect(mockCreateApproval).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// allow
// ---------------------------------------------------------------------------

describe('operator — allow verdict', () => {
  it('dispatches an allowed tool normally (select_rows)', async () => {
    oneToolCallThenStop('select_rows', { app_id: 'app-1', table: 't' });

    const events = await collect(runAgentTurn(operatorInput()));

    expect(mockCallMcpTool).toHaveBeenCalledTimes(1);
    expect(mockCallMcpTool).toHaveBeenCalledWith(
      'select_rows',
      { app_id: 'app-1', table: 't' },
      'operator-service-key',
      ORG_ID,
    );
    expect(mockCreateApproval).not.toHaveBeenCalled();
    const result = events.find((e) => e.type === 'tool_result') as
      | Extract<LoopEvent, { type: 'tool_result' }>
      | undefined;
    expect(result!.error).toBeUndefined();
  });

  it('dispatches an allowed manage_substrate read action', async () => {
    oneToolCallThenStop('manage_substrate', { action: 'find_entities' });

    await collect(runAgentTurn(operatorInput()));

    expect(mockCallMcpTool).toHaveBeenCalledTimes(1);
    expect(mockCreateApproval).not.toHaveBeenCalled();
  });

  /**
   * ACCEPTED RISK, PINNED.
   *
   * manage_integrations is the real outbound-email path and it is deliberately
   * UNGATED for the headless operator. Three-times-confirmed user decision,
   * most recently 2026-08-06 with explicit awareness that C3 makes it live.
   *
   * This test exists so that a future change cannot silently gate it: if it
   * starts failing, someone has changed the accepted risk, and that is a
   * decision for the user, not a bug to fix by editing this test.
   */
  it('dispatches manage_integrations with NO approval (accepted risk, pinned)', async () => {
    oneToolCallThenStop('manage_integrations', { action: 'send_email', to: 'a@b.com' });

    const events = await collect(runAgentTurn(operatorInput()));

    expect(mockCreateApproval).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === 'approval_required')).toBe(false);
    expect(mockCallMcpTool).toHaveBeenCalledTimes(1);
    expect(mockCallMcpTool).toHaveBeenCalledWith(
      'manage_integrations',
      { action: 'send_email', to: 'a@b.com' },
      'operator-service-key',
      ORG_ID,
    );
  });
});

// ---------------------------------------------------------------------------
// catalog (the affordance)
// ---------------------------------------------------------------------------

describe('operator — catalog filtering (affordance, not the control)', () => {
  it('offers the model only tools the operator may call, MINUS the sandbox tool when no codeExecutor is supplied', async () => {
    const { bodies } = oneToolCallThenStop('select_rows', { app_id: 'app-1' });

    await collect(runAgentTurn(operatorInput()));

    const offered = toolNamesSent(bodies[0]);
    // `run_sandbox_code` is 'allow' in the policy table (see
    // operator-policy.ts), but this turn supplies no `codeExecutor` — the
    // catalog-construction filter in loop.ts is what actually withholds it,
    // NOT operatorPolicyFor/isOperatorToolAllowed, so `expected` must exclude
    // it explicitly rather than by relying on the policy helper.
    const expected = getToolCatalog()
      .map((t) => t.name)
      .filter(isOperatorToolAllowed)
      .filter((n) => n !== OPERATOR_SANDBOX_CODE_TOOL);

    expect(offered.sort()).toEqual(expected.sort());
    expect(offered.length).toBeGreaterThan(0);
    expect(offered).toContain('manage_substrate');
    expect(offered).not.toContain(OPERATOR_SANDBOX_CODE_TOOL);
    for (const denied of ['manage_api_keys', 'manage_auth_users', 'deploy_function', 'manage_rls', 'seed_database', 'write_file']) {
      expect(offered).not.toContain(denied);
    }
  });

  it('offers the sandbox tool once a codeExecutor is supplied for the turn', async () => {
    const { bodies } = oneToolCallThenStop('select_rows', { app_id: 'app-1' });
    const codeExecutor = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });

    await collect(runAgentTurn(operatorInput({ codeExecutor })));

    const offered = toolNamesSent(bodies[0]);
    expect(offered).toContain(OPERATOR_SANDBOX_CODE_TOOL);
    // Supplying a codeExecutor must not itself invoke it — only a model tool
    // call should.
    expect(codeExecutor).not.toHaveBeenCalled();
  });

  it('never offers the sandbox tool to a human conversation, even with a codeExecutor supplied', async () => {
    // Defence in depth: nothing should ever pass a codeExecutor for a human
    // turn, but if it happened, the operatorOnly filter must still win.
    const { bodies } = oneToolCallThenStop('manage_app', { action: 'list' });
    const codeExecutor = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });

    await collect(runAgentTurn(humanInput({ codeExecutor })));

    const offered = toolNamesSent(bodies[0]);
    expect(offered).not.toContain(OPERATOR_SANDBOX_CODE_TOOL);
  });
});

// ---------------------------------------------------------------------------
// run_sandbox_code dispatch
// ---------------------------------------------------------------------------

describe('operator — run_sandbox_code dispatch', () => {
  it('routes to codeExecutor in-process, never through MCP', async () => {
    oneToolCallThenStop(OPERATOR_SANDBOX_CODE_TOOL, { code: 'print(1)' });
    const codeExecutor = vi.fn().mockResolvedValue({ stdout: '1\n', stderr: '' });

    const events = await collect(runAgentTurn(operatorInput({ codeExecutor })));

    expect(codeExecutor).toHaveBeenCalledWith('print(1)');
    expect(mockCallMcpTool).not.toHaveBeenCalled();
    const result = events.find((e) => e.type === 'tool_result') as
      | Extract<LoopEvent, { type: 'tool_result' }>
      | undefined;
    expect(result!.error).toBeUndefined();
    expect(result!.result).toEqual({ stdout: '1\n', stderr: '' });
  });

  it('surfaces a codeExecutor rejection as an ordinary tool error, not a turn failure', async () => {
    oneToolCallThenStop(OPERATOR_SANDBOX_CODE_TOOL, { code: 'raise Exception("boom")' });
    const codeExecutor = vi.fn().mockRejectedValue(new Error('sandbox exec failed: boom'));

    const events = await collect(runAgentTurn(operatorInput({ codeExecutor })));

    const result = events.find((e) => e.type === 'tool_result') as
      | Extract<LoopEvent, { type: 'tool_result' }>
      | undefined;
    expect(result!.error).toContain('boom');
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });

  it('THE SAFETY-CRITICAL CASE: refuses the call with NO codeExecutor, and never runs code on the host', async () => {
    // The model should never even be offered the tool in this case (covered
    // above), but this pins the dispatch-site refusal too, in case the model
    // names it anyway (hallucination, or a stale/cached tool list).
    oneToolCallThenStop(OPERATOR_SANDBOX_CODE_TOOL, { code: 'import os; os.system("rm -rf /")' });

    const events = await collect(runAgentTurn(operatorInput()));

    expect(mockCallMcpTool).not.toHaveBeenCalled();
    const result = events.find((e) => e.type === 'tool_result') as
      | Extract<LoopEvent, { type: 'tool_result' }>
      | undefined;
    expect(result!.error).toBeDefined();
    expect(result!.result).toBeUndefined();
  });

  it('refuses run_sandbox_code for a human conversation even if a codeExecutor were somehow supplied', async () => {
    oneToolCallThenStop(OPERATOR_SANDBOX_CODE_TOOL, { code: 'print(1)' });
    const codeExecutor = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });

    const events = await collect(runAgentTurn(humanInput({ codeExecutor })));

    expect(codeExecutor).not.toHaveBeenCalled();
    const result = events.find((e) => e.type === 'tool_result') as
      | Extract<LoopEvent, { type: 'tool_result' }>
      | undefined;
    expect(result!.error).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// internal (non-model-driven) MCP calls
// ---------------------------------------------------------------------------

describe('operator — loop-initiated MCP calls', () => {
  it('does not let schema injection call manage_schema on the operator credential', async () => {
    // Schema injection is loop-initiated, not model-driven, and bypasses the
    // dispatch site entirely — it goes through deps.mcp.
    mockGetRecentToolArgs.mockResolvedValue([{ app_id: 'app-1' } as never]);
    oneToolCallThenStop('select_rows', { app_id: 'app-1' });

    await collect(runAgentTurn(operatorInput()));

    // NOTE the arity: schema-context calls mcp.call(name, args, jwt) with THREE
    // arguments, while the dispatch site calls callMcpTool with FOUR. A
    // `not.toHaveBeenCalledWith(..., expect.anything() x4)` here would never
    // match the 3-arg call and would pass vacuously. Assert on the names.
    expect(mockCallMcpTool.mock.calls.map((c) => c[0])).not.toContain('manage_schema');
    // The turn still completes — the refusal degrades the prompt, it does not
    // break the turn.
    expect(mockCallMcpTool.mock.calls.map((c) => c[0])).toContain('select_rows');
  });

  it('STILL calls manage_schema for a human conversation (no assistant regression)', async () => {
    mockGetRecentToolArgs.mockResolvedValue([{ app_id: 'app-1' } as never]);
    mockCallMcpTool.mockResolvedValue({ ok: true, result: { schema: { tables: {} } } } as never);
    oneToolCallThenStop('select_rows', { app_id: 'app-1' });

    await collect(runAgentTurn(humanInput()));

    expect(mockCallMcpTool).toHaveBeenCalledWith(
      'manage_schema',
      { action: 'get', app_id: 'app-1' },
      'user-jwt',
    );
  });
});

// ---------------------------------------------------------------------------
// the human assistant must be completely unaffected
// ---------------------------------------------------------------------------

describe('non-operator conversation is unaffected', () => {
  // The assistant's catalog is every tool EXCEPT the `operatorOnly` ones,
  // which exist only for the headless operator (currently just the scratchpad
  // write). The assistant's list is therefore exactly what it was before those
  // tools were added — see operator-scratchpad.test.ts, which pins that the
  // filter actually removes something so this is not vacuous.
  it('is offered the FULL catalog (minus operator-only tools)', async () => {
    const { bodies } = oneToolCallThenStop('manage_app', { action: 'list' });

    await collect(runAgentTurn(humanInput()));

    const offered = toolNamesSent(bodies[0]);
    expect(offered.sort()).toEqual(
      getToolCatalog().filter((t) => t.operatorOnly !== true).map((t) => t.name).sort(),
    );
  });

  it('dispatches tools the OPERATOR would be denied', async () => {
    oneToolCallThenStop('manage_api_keys', { action: 'create', app_id: 'app-1' });

    const events = await collect(runAgentTurn(humanInput()));

    expect(mockCallMcpTool).toHaveBeenCalledTimes(1);
    expect(mockCallMcpTool).toHaveBeenCalledWith(
      'manage_api_keys',
      { action: 'create', app_id: 'app-1' },
      'user-jwt',
      ORG_ID,
    );
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  it('still gates on sensitivityFor, still consults checkTrust (manage_billing)', async () => {
    oneToolCallThenStop('manage_billing', { action: 'get' });

    const events = await collect(runAgentTurn(humanInput()));

    expect(mockCheckTrust).toHaveBeenCalledWith(stubPool, 'conv-1', 'manage_billing');
    expect(mockCreateApproval).toHaveBeenCalledWith(
      stubPool,
      expect.objectContaining({ toolName: 'manage_billing', sensitivity: 'destructive' }),
    );
    expect(mockCallMcpTool).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === 'approval_required')).toBe(true);
  });

  it('conversation-wide trust still bypasses the sensitivity gate', async () => {
    mockCheckTrust.mockResolvedValue(true);
    oneToolCallThenStop('manage_app', { action: 'delete', app_id: 'app-1' });

    await collect(runAgentTurn(humanInput()));

    expect(mockCheckTrust).toHaveBeenCalledWith(stubPool, 'conv-1', 'manage_app');
    expect(mockCreateApproval).not.toHaveBeenCalled();
    expect(mockCallMcpTool).toHaveBeenCalledTimes(1);
  });

  it('manage_substrate stays ungated for the assistant (documented, accepted)', async () => {
    // The operator's substrate action policy deliberately does NOT govern the
    // human assistant — user decision 2026-08-06.
    oneToolCallThenStop('manage_substrate', { action: 'set_yolo', enabled: true });

    await collect(runAgentTurn(humanInput()));

    expect(mockCreateApproval).not.toHaveBeenCalled();
    expect(mockCallMcpTool).toHaveBeenCalledTimes(1);
  });
});
