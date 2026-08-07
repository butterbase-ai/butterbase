/**
 * Fix D — the cross-org `org_id` guard.
 *
 * THE DEFECT. `manage_substrate` accepts an `org_id` ARGUMENT and forwards it
 * as `x-organization-id`, overriding the header `callMcpTool` sets from the
 * caller's own org. No verdict table ever looked at it.
 *
 * On the operator's own turn that was contained only by an EXTERNAL property —
 * the stored credential is an org-bound service key, so a foreign `org_id`
 * 403s at the MCP server. On the APPROVAL REPLAY nothing contained it: the
 * replay runs on the APPROVING HUMAN's bearer token, and for JWT auth
 * substrate resolves the org against `organization_members`. So an operator in
 * org A could propose `{action:'propose', capability:'send_email_draft',
 * org_id:'<org B>'}`, and one click from an org A member who also belongs to
 * org B would write into org B's substrate.
 *
 * TWO PATHS, TWO GUARDS — both are tested here, because a guard on only one is
 * the same class of bug as the original allowlist-not-on-the-execution-path
 * defect:
 *
 *   1. the operator's LIVE DISPATCH   — `operatorPolicyForOrg` at loop.ts's
 *      dispatch site and on `turnMcp`. The agent sees a refusal as a tool
 *      result and can adapt, rather than the proposal sitting there waiting
 *      for a human to click it.
 *   2. the HUMAN-APPROVED REPLAY      — `executeOnce` in tool-bridge.ts, ahead
 *      of `pool.connect()`. This is the path that was actually exploitable.
 *
 * The org compared against is TRUSTED on both:
 *   - dispatch: derived from the `operator:<org>` user-id sentinel, which
 *     operator-turn.ts hardcodes from `job.orgId`.
 *   - replay: `resolveCallerOrgId` verifies `organization_members` and returns
 *     the canonical id, and `getApprovalForOrg` then only finds the row if it
 *     hangs off THAT org's operator conversation.
 * Neither is ever read out of the model's arguments.
 *
 * Deliberately a separate file from loop.test.ts (pre-existing JS heap OOM),
 * and it uses the REAL policy module rather than a hand-written copy.
 */

import { describe, it, expect, vi, beforeEach, afterAll, type MockedFunction } from 'vitest';
import pgDefault, { Pool } from 'pg';

// PARTIAL mocks throughout: the loop half needs the writes stubbed out, but
// the replay half runs against real Postgres and needs the rest of these
// modules intact (stripJsonbNulls, createApproval, getApprovalForOrg, …).
vi.mock('../store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../store.js')>();
  return {
    ...actual,
    appendMessage: vi.fn(),
    listMessages: vi.fn(),
    getRecentToolArgs: vi.fn(),
    upsertSnapshotLabel: vi.fn(),
    getConversation: vi.fn(),
    updateConversationTitle: vi.fn(),
  };
});

vi.mock('../mcp-client.js', () => ({ callMcpTool: vi.fn() }));

vi.mock('../approvals-store.js', async (importOriginal) => {
  // The loop half needs createApproval/checkTrust mocked; the replay half
  // needs the REAL createApproval against Postgres. Keep both.
  const actual = await importOriginal<typeof import('../approvals-store.js')>();
  return { ...actual, createApproval: vi.fn(), checkTrust: vi.fn() };
});

import * as storeModule from '../store.js';
import * as mcpClientModule from '../mcp-client.js';
import * as approvalsStoreModule from '../approvals-store.js';
import {
  orgIdArgIsForeign,
  operatorPolicyFor,
  operatorPolicyForOrg,
  principalMayExecute,
  OPERATOR_TOOL_SURFACE,
} from '../operator-policy.js';
import { operatorUserId, operatorOrgIdFromUserId, getOrCreateOperatorConversation } from '../operator-store.js';
import { executeOnce } from '../tool-bridge.js';
import { executeApprovedOperatorTool } from '../substrate-approval-bridge.js';
import { runAgentTurn, type LoopEvent } from '../loop.js';

const mockAppendMessage = storeModule.appendMessage as MockedFunction<typeof storeModule.appendMessage>;
const mockListMessages = storeModule.listMessages as MockedFunction<typeof storeModule.listMessages>;
const mockGetRecentToolArgs = storeModule.getRecentToolArgs as MockedFunction<typeof storeModule.getRecentToolArgs>;
const mockGetConversation = storeModule.getConversation as MockedFunction<typeof storeModule.getConversation>;
const mockUpdateConversationTitle = storeModule.updateConversationTitle as MockedFunction<typeof storeModule.updateConversationTitle>;
const mockCallMcpTool = mcpClientModule.callMcpTool as MockedFunction<typeof mcpClientModule.callMcpTool>;
const mockCreateApproval = approvalsStoreModule.createApproval as MockedFunction<typeof approvalsStoreModule.createApproval>;
const mockCheckTrust = approvalsStoreModule.checkTrust as MockedFunction<typeof approvalsStoreModule.checkTrust>;

/** Org A — the operator's own org. */
const ORG_A = '11111111-1111-4111-8111-111111111111';
/** Org B — a DIFFERENT org the approving human also belongs to. */
const ORG_B = '22222222-2222-4222-8222-222222222222';

const OPERATOR_USER = operatorUserId(ORG_A);
const HUMAN_USER = 'cognito-sub-abc';

// ---------------------------------------------------------------------------
// unit — the predicate itself
// ---------------------------------------------------------------------------

describe('orgIdArgIsForeign', () => {
  it('is false when no org_id is supplied (the normal call shape)', () => {
    expect(orgIdArgIsForeign({ action: 'find_entities' }, ORG_A)).toBe(false);
    expect(orgIdArgIsForeign({}, ORG_A)).toBe(false);
    expect(orgIdArgIsForeign(undefined, ORG_A)).toBe(false);
    expect(orgIdArgIsForeign(null, ORG_A)).toBe(false);
    expect(orgIdArgIsForeign({ org_id: undefined }, ORG_A)).toBe(false);
  });

  it('is false for the caller\'s OWN org, including case/whitespace variants', () => {
    expect(orgIdArgIsForeign({ org_id: ORG_A }, ORG_A)).toBe(false);
    expect(orgIdArgIsForeign({ org_id: `  ${ORG_A.toUpperCase()} ` }, ORG_A)).toBe(false);
    expect(orgIdArgIsForeign(JSON.stringify({ org_id: ORG_A }), ORG_A)).toBe(false);
  });

  it('is TRUE for any other org', () => {
    expect(orgIdArgIsForeign({ org_id: ORG_B }, ORG_A)).toBe(true);
    expect(orgIdArgIsForeign(JSON.stringify({ action: 'propose', org_id: ORG_B }), ORG_A)).toBe(true);
  });

  it('does not match on a prefix', () => {
    expect(orgIdArgIsForeign({ org_id: `${ORG_A}-evil` }, ORG_A)).toBe(true);
    expect(orgIdArgIsForeign({ org_id: ORG_A.slice(0, -1) }, ORG_A)).toBe(true);
  });

  it('fails CLOSED on args it cannot read, and on a non-string org_id', () => {
    expect(orgIdArgIsForeign('not json', ORG_A)).toBe(true);
    expect(orgIdArgIsForeign('[1,2,3]', ORG_A)).toBe(true);
    expect(orgIdArgIsForeign(42, ORG_A)).toBe(true);
    expect(orgIdArgIsForeign({ org_id: null }, ORG_A)).toBe(true);
    expect(orgIdArgIsForeign({ org_id: 7 }, ORG_A)).toBe(true);
    expect(orgIdArgIsForeign({ org_id: { toString: () => ORG_A } }, ORG_A)).toBe(true);
  });

  it('fails CLOSED when the caller\'s own org is unknown, but only if an org_id was named', () => {
    expect(orgIdArgIsForeign({ org_id: ORG_A }, null)).toBe(true);
    expect(orgIdArgIsForeign({ org_id: ORG_A }, '   ')).toBe(true);
    // Nothing to compare, but nothing being targeted either — the header
    // already carries the right org.
    expect(orgIdArgIsForeign({ action: 'find_entities' }, null)).toBe(false);
  });

  it('treats a blank org_id as absent (it forwards no header override)', () => {
    expect(orgIdArgIsForeign({ org_id: '' }, ORG_A)).toBe(false);
    expect(orgIdArgIsForeign({ org_id: '   ' }, ORG_A)).toBe(false);
  });

  /**
   * SCOPE, PINNED. Only the top-level `org_id` key is inspected. It is the one
   * field any allowlisted tool turns into `x-organization-id`. `organization_id`
   * is an ordinary column name that `select_rows` and `manage_people` may
   * legitimately carry in their arguments — widening to it would break real
   * calls without closing anything.
   */
  it('does NOT inspect an `organization_id` column filter', () => {
    expect(orgIdArgIsForeign({ table: 't', where: { organization_id: ORG_B } }, ORG_A)).toBe(false);
    expect(orgIdArgIsForeign({ organization_id: ORG_B }, ORG_A)).toBe(false);
  });
});

describe('operatorOrgIdFromUserId', () => {
  it('reads the org back out of the sentinel', () => {
    expect(operatorOrgIdFromUserId(OPERATOR_USER)).toBe(ORG_A);
  });

  it('is null for a human, and for a degenerate sentinel', () => {
    expect(operatorOrgIdFromUserId(HUMAN_USER)).toBeNull();
    expect(operatorOrgIdFromUserId(operatorUserId(''))).toBeNull();
    expect(operatorOrgIdFromUserId(undefined)).toBeNull();
  });
});

describe('operatorPolicyForOrg', () => {
  it('denies a foreign org_id AHEAD of every other verdict', () => {
    // Would otherwise be 'allow'.
    expect(operatorPolicyFor('manage_substrate', { action: 'find_entities' })).toBe('allow');
    expect(operatorPolicyForOrg('manage_substrate', { action: 'find_entities', org_id: ORG_B }, ORG_A)).toBe('deny');

    // Would otherwise be 'approval'.
    expect(operatorPolicyFor('manage_substrate', { action: 'propose', capability: 'send_email_draft' })).toBe('approval');
    expect(
      operatorPolicyForOrg('manage_substrate', { action: 'propose', capability: 'send_email_draft', org_id: ORG_B }, ORG_A),
    ).toBe('deny');
  });

  it('is identical to the table when the org_id is the operator\'s own or absent', () => {
    for (const args of [
      { action: 'find_entities' },
      { action: 'find_entities', org_id: ORG_A },
      { action: 'propose', capability: 'send_email_draft' },
      { action: 'propose', capability: 'send_email_draft', org_id: ORG_A },
      { action: 'delete_rule', rule_id: 'r-1' },
      { action: 'approve', action_id: 'a-1' },
    ]) {
      expect(operatorPolicyForOrg('manage_substrate', args, ORG_A)).toBe(
        operatorPolicyFor('manage_substrate', args),
      );
    }
  });

  /**
   * SCOPE FINDING, PINNED. `manage_substrate` is the ONLY allowlisted tool that
   * takes an org-scoping argument at all — verified against the MCP tool
   * schemas: `manage_integrations`, `manage_people`, `query_audit_logs`,
   * `select_rows` and `butterbase_docs` have no `org_id`/`organization_id`
   * parameter, so their org is fixed by the `x-organization-id` header alone.
   *
   * The guard is nonetheless applied per-CALL and not per-tool, so if one of
   * them ever grows such an argument it is covered on the day it lands rather
   * than on the day somebody remembers to extend a list.
   */
  it('applies to every tool on the operator surface, not just manage_substrate', () => {
    for (const tool of OPERATOR_TOOL_SURFACE) {
      expect(operatorPolicyForOrg(tool, { org_id: ORG_B }, ORG_A), tool).toBe('deny');
      expect(operatorPolicyForOrg(tool, {}, ORG_A), tool).not.toBe('deny');
    }
  });

  it('outranks yolo_mode — pre-authorising YOUR org authorises nothing in another', () => {
    for (const tool of OPERATOR_TOOL_SURFACE) {
      expect(operatorPolicyForOrg(tool, { org_id: ORG_B }, ORG_A, { yoloMode: true }), tool).toBe('deny');
    }
  });
});

// ---------------------------------------------------------------------------
// path 1 — the operator's own turn
// ---------------------------------------------------------------------------

const stubPool = {} as pgDefault.Pool;

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
  const fetchMock = vi.fn(async () => {
    pass += 1;
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
  });
  global.fetch = fetchMock as unknown as typeof fetch;
}

function operatorInput(overrides: Record<string, unknown> = {}) {
  return {
    conversationId: 'conv-1',
    userId: OPERATOR_USER,
    jwt: 'operator-service-key',
    userMessage: 'Scheduled wake.',
    model: 'claude-sonnet-4-5',
    pool: stubPool,
    organizationId: ORG_A,
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
    organizationId: ORG_A,
    ...overrides,
  };
}

function toolResultOf(events: LoopEvent[]) {
  return events.find((e) => e.type === 'tool_result') as
    | Extract<LoopEvent, { type: 'tool_result' }>
    | undefined;
}

describe('operator dispatch — a foreign org_id is refused on the operator\'s OWN turn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAppendMessage.mockResolvedValue(stubMessage);
    mockListMessages.mockResolvedValue([]);
    mockGetRecentToolArgs.mockResolvedValue([]);
    mockGetConversation.mockResolvedValue(null);
    mockUpdateConversationTitle.mockResolvedValue(null);
    mockCheckTrust.mockResolvedValue(false);
    mockCallMcpTool.mockResolvedValue({ ok: true, result: { content: [{ type: 'text', text: '{}' }] } } as never);
    mockCreateApproval.mockResolvedValue({ id: 'approval-1' } as never);
  });

  /**
   * THE HEADLINE. Refused at PROPOSE time, not merely at approval time. A
   * refusal the agent sees as a tool result is strictly better than one that
   * waits silently for a human to click: no approval row is created, so there
   * is nothing in the feed for a dual-member to click at all.
   */
  it('refuses the exact exploit payload and creates NO approval', async () => {
    oneToolCallThenStop('manage_substrate', {
      action: 'propose',
      capability: 'send_email_draft',
      org_id: ORG_B,
    });

    const events = await collect(runAgentTurn(operatorInput()));

    expect(mockCallMcpTool).not.toHaveBeenCalled();
    expect(mockCreateApproval).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === 'approval_required')).toBe(false);

    // Ordinary tool error: the turn is not killed and the model can adapt.
    expect(toolResultOf(events)!.error).toContain('not permitted for the autonomous operator');
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events.some((e) => e.type === 'done')).toBe(true);

    // The refusal answers the assistant's tool_call, so the history is never
    // left ending in an unanswered tool_call.
    expect(mockAppendMessage).toHaveBeenCalledWith(
      stubPool,
      'conv-1',
      expect.objectContaining({
        role: 'tool',
        toolCallId: 'call-1',
        toolName: 'manage_substrate',
        toolResult: { error: expect.stringContaining('not permitted') },
      }),
    );
  });

  it('refuses a foreign org_id on an otherwise-ALLOWED read too', async () => {
    oneToolCallThenStop('manage_substrate', { action: 'find_entities', org_id: ORG_B });

    const events = await collect(runAgentTurn(operatorInput()));

    expect(mockCallMcpTool).not.toHaveBeenCalled();
    expect(toolResultOf(events)!.error).toContain('not permitted for the autonomous operator');
  });

  it('refuses a foreign org_id on manage_integrations — the real outbound path', async () => {
    // manage_integrations stays ALLOWLISTED and UNGATED (accepted risk). This
    // guard is about WHICH ORG a call targets, not about whether it needs
    // approval, and the two must not be conflated.
    oneToolCallThenStop('manage_integrations', { action: 'send_email', to: 'a@b.com', org_id: ORG_B });

    const events = await collect(runAgentTurn(operatorInput()));

    expect(mockCallMcpTool).not.toHaveBeenCalled();
    expect(toolResultOf(events)!.error).toContain('not permitted for the autonomous operator');
  });

  it('still dispatches normally with the operator\'s OWN org_id', async () => {
    oneToolCallThenStop('manage_substrate', { action: 'find_entities', org_id: ORG_A });

    const events = await collect(runAgentTurn(operatorInput()));

    expect(mockCallMcpTool).toHaveBeenCalledTimes(1);
    expect(mockCallMcpTool).toHaveBeenCalledWith(
      'manage_substrate',
      { action: 'find_entities', org_id: ORG_A },
      'operator-service-key',
      ORG_A,
      // No traceId set on this test's `operatorInput()` — D1 threading is
      // covered separately in loop-operator-policy.test.ts.
      undefined,
    );
    expect(toolResultOf(events)!.error).toBeUndefined();
  });

  it('still dispatches normally with NO org_id at all', async () => {
    oneToolCallThenStop('manage_substrate', { action: 'find_entities' });

    const events = await collect(runAgentTurn(operatorInput()));

    expect(mockCallMcpTool).toHaveBeenCalledTimes(1);
    expect(toolResultOf(events)!.error).toBeUndefined();
  });

  it('still GATES a same-org approval_required propose (the guard did not swallow the gate)', async () => {
    oneToolCallThenStop('manage_substrate', {
      action: 'propose',
      capability: 'send_email_draft',
      org_id: ORG_A,
    });

    const events = await collect(runAgentTurn(operatorInput()));

    // `manage_substrate get_settings` (the yolo probe) is the one call a gated
    // verdict legitimately makes; the PROPOSE itself must not have dispatched.
    expect(
      mockCallMcpTool.mock.calls.filter((c) => (c[1] as { action?: string })?.action !== 'get_settings'),
    ).toEqual([]);
    expect(mockCreateApproval).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.type === 'approval_required')).toBe(true);
  });

  /**
   * The HUMAN assistant legitimately operates across every org its user belongs
   * to. This restriction is operator-only, and the same payload that the
   * operator is refused must go through untouched for a person.
   */
  it('does NOT restrict the human assistant', async () => {
    oneToolCallThenStop('manage_substrate', { action: 'find_entities', org_id: ORG_B });

    const events = await collect(runAgentTurn(humanInput()));

    expect(mockCallMcpTool).toHaveBeenCalledTimes(1);
    expect(mockCallMcpTool).toHaveBeenCalledWith(
      'manage_substrate',
      { action: 'find_entities', org_id: ORG_B },
      'user-jwt',
      ORG_A,
      undefined,
    );
    expect(toolResultOf(events)!.error).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// path 2 — the human-approved replay (the exploitable one)
// ---------------------------------------------------------------------------

const pool = new Pool({ connectionString: process.env.CONTROL_TEST_DATABASE_URL });

/**
 * The REAL createApproval. The module-level `vi.mock` above replaces the export
 * for every importer, including this file, so a plain named import would hand
 * back the loop half's `vi.fn()` and seed a fake `approval-1` id.
 */
const realApprovals = await vi.importActual<typeof import('../approvals-store.js')>(
  '../approvals-store.js',
);

async function seedApproval(toolArgs: unknown) {
  const convId = await getOrCreateOperatorConversation(pool, ORG_A, 'claude-sonnet-4-5');
  return realApprovals.createApproval(pool, {
    conversationId: convId,
    turnMessageId: '33333333-3333-3333-3333-333333333333',
    toolName: 'manage_substrate',
    toolArgs: toolArgs as Record<string, unknown>,
    sensitivity: 'destructive',
  });
}

async function executionRowCount(approvalId: string): Promise<number> {
  const r = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM dashboard_agent_tool_executions WHERE approval_id = $1`,
    [approvalId],
  );
  return Number(r.rows[0].n);
}

describe('approval replay — a stored foreign org_id is refused under a HUMAN principal', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockCallMcpTool.mockResolvedValue({ ok: true, result: { id: 'act_1' } } as never);
    await pool.query(`DELETE FROM dashboard_agent_conversations WHERE organization_id = $1`, [ORG_A]);
  });

  afterAll(async () => {
    await pool.end();
  });

  /**
   * The reviewer's finding, end to end. `principalMayExecute('human', …)`
   * returns TRUE for this payload — the tool is allowlisted and the action
   * denials are lifted for a human — so the tool-level check cannot stop it.
   * Only the org guard can.
   */
  it('principalMayExecute alone does NOT stop it — the org guard is the only control', () => {
    const payload = { action: 'propose', capability: 'send_email_draft', org_id: ORG_B };
    expect(principalMayExecute('human', 'manage_substrate', payload)).toBe(true);
    expect(operatorPolicyForOrg('manage_substrate', payload, ORG_A)).toBe('deny');
  });

  it('refuses at executeOnce, fires no tool call, and writes no execution row', async () => {
    const approval = await seedApproval({ action: 'propose', capability: 'send_email_draft', org_id: ORG_B });

    const result = await executeOnce(pool, {
      approvalId: approval.id,
      name: 'manage_substrate',
      args: { action: 'propose', capability: 'send_email_draft', org_id: ORG_B },
      // The approver's own bearer token: they are a member of BOTH orgs, so
      // substrate would happily resolve org B for them.
      jwt: 'approver-jwt-member-of-both-orgs',
      orgId: ORG_A,
      principal: 'human',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('outside this operator\'s organization');
    expect(mockCallMcpTool).not.toHaveBeenCalled();
    // Refused ahead of pool.connect(): no advisory lock, no ledger row, and
    // nothing that could later be served back out of the exactly-once cache.
    expect(await executionRowCount(approval.id)).toBe(0);
  });

  it('refuses through the full substrate approval bridge (the production replay path)', async () => {
    const approval = await seedApproval({ action: 'propose', capability: 'send_email_draft', org_id: ORG_B });

    const result = await executeApprovedOperatorTool(pool, {
      approvalId: approval.id,
      name: 'manage_substrate',
      args: { action: 'propose', capability: 'send_email_draft', org_id: ORG_B },
      jwt: 'approver-jwt-member-of-both-orgs',
      orgId: ORG_A,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('outside this operator\'s organization');
    // Neither the propose nor the bridged native approve reached substrate.
    expect(mockCallMcpTool).not.toHaveBeenCalled();
  });

  it('refuses an operator-principal replay for the same payload', async () => {
    const approval = await seedApproval({ action: 'propose', capability: 'send_email_draft', org_id: ORG_B });

    const result = await executeOnce(pool, {
      approvalId: approval.id,
      name: 'manage_substrate',
      args: { action: 'propose', capability: 'send_email_draft', org_id: ORG_B },
      jwt: 'operator-service-key',
      orgId: ORG_A,
      principal: 'operator',
    });

    expect(result.ok).toBe(false);
    expect(mockCallMcpTool).not.toHaveBeenCalled();
  });

  it('STILL executes a same-org approval, and still exactly once', async () => {
    const approval = await seedApproval({ action: 'propose', capability: 'send_email_draft', org_id: ORG_A });

    const opts = {
      approvalId: approval.id,
      name: 'manage_substrate',
      args: { action: 'propose', capability: 'send_email_draft', org_id: ORG_A },
      jwt: 'approver-jwt',
      orgId: ORG_A,
      principal: 'human' as const,
    };
    const first = await executeOnce(pool, opts);
    const second = await executeOnce(pool, opts);

    expect(first).toEqual({ ok: true, result: { id: 'act_1' } });
    expect(second).toEqual(first);
    expect(mockCallMcpTool).toHaveBeenCalledTimes(1);
    expect(await executionRowCount(approval.id)).toBe(1);
  });

  it('STILL executes an approval with no org_id at all', async () => {
    const approval = await seedApproval({ action: 'propose', capability: 'send_email_draft' });

    const result = await executeOnce(pool, {
      approvalId: approval.id,
      name: 'manage_substrate',
      args: { action: 'propose', capability: 'send_email_draft' },
      jwt: 'approver-jwt',
      orgId: ORG_A,
      principal: 'human',
    });

    expect(result.ok).toBe(true);
    expect(mockCallMcpTool).toHaveBeenCalledTimes(1);
  });
});
