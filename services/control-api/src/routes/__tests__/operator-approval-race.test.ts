/**
 * I-1 regression — an approve and a deny racing ONE escalation approval must
 * not let either side report success for a call it never made.
 *
 * THE DEFECT. `executeOnce` caches on `approval_id` ALONE. That was sound
 * while one approval id meant one distinct call. Fix E added a SECOND call
 * site under the same key with DIFFERENT arguments: the approve goes through
 * `executeApprovedOperatorTool`, the deny went through
 * `rejectEscalatedSubstrateAction`. Under a genuine race both resolvers pass
 * `completeApprovalResolution`'s status read, the winner executes and caches,
 * and the LOSER is served the winner's envelope — a deny reading back an
 * `approve` result saw `isError` false and reported
 * `{ attempted: true, ok: true }`. If that deny then won `resolveApproval`'s
 * conditional UPDATE, the dashboard recorded `denied` +
 * `substrate_action_rejected: true` for an action substrate had EXECUTED.
 *
 * No side effect was ever duplicated — that is not what broke. What broke is
 * that the RECORD could invert substrate's ledger, which is the exact
 * disagreement fix E exists to prevent.
 *
 * THE FIX. One approval id, one `executeOnce` call site (the approve). The
 * deny calls substrate directly, re-applying the principal and cross-org
 * guards inline, because `rejectAction` is already at-most-once on its own
 * terms (`FOR UPDATE` + a `status = 'proposed'` check in
 * substrate-core/src/action-executor.ts).
 *
 * These tests model substrate's ledger transaction: the FIRST resolution to
 * arrive transitions the action; every later one gets substrate's real
 * "action is not in proposed state" error. Only mcp-client is mocked — the
 * approvals store, the message store, `executeOnce` and its advisory lock all
 * run for real against the control-plane database.
 */

import { describe, it, expect, vi, beforeEach, afterAll, type MockedFunction } from 'vitest';
import { Pool } from 'pg';

vi.mock('../../services/dashboard-agent/mcp-client.js', async () => {
  const actual = await vi.importActual<typeof import('../../services/dashboard-agent/mcp-client.js')>(
    '../../services/dashboard-agent/mcp-client.js',
  );
  return { ...actual, callMcpTool: vi.fn() };
});

import * as mcpClientModule from '../../services/dashboard-agent/mcp-client.js';
import { resolveOperatorApproval } from '../dashboard-agent.js';
import { getOrCreateOperatorConversation } from '../../services/dashboard-agent/operator-store.js';
import {
  createSubstrateEscalationApproval,
  getApprovalForOrg,
} from '../../services/dashboard-agent/approvals-store.js';
import { appendMessage, listMessages, type Message } from '../../services/dashboard-agent/store.js';

const mockCallMcpTool = mcpClientModule.callMcpTool as MockedFunction<typeof mcpClientModule.callMcpTool>;

const ORG = 'org-approval-race-test';
const ACTION_ID = 'act_01HZX9RACED';
const USER = 'cognito-sub-approver';

const pool = new Pool({ connectionString: process.env.CONTROL_TEST_DATABASE_URL });

beforeEach(async () => {
  vi.clearAllMocks();
  await pool.query(`DELETE FROM dashboard_agent_conversations WHERE organization_id = $1`, [ORG]);
});

afterAll(async () => {
  await pool.query(`DELETE FROM dashboard_agent_conversations WHERE organization_id = $1`, [ORG]);
  await pool.end();
});

function mcpEnvelope(payload: unknown, isError = false) {
  return { ok: true, result: { isError, content: [{ type: 'text', text: JSON.stringify(payload) }] } };
}

/** What loop.ts leaves behind on a POST-dispatch substrate escalation. */
async function escalate() {
  const conversationId = await getOrCreateOperatorConversation(pool, ORG, 'claude-sonnet-4-5');
  const toolCallId = 'call_propose_race';
  const proposeArgs = { action: 'propose', capability: 'record_decision', payload: { note: 'x' } };

  const assistant = await appendMessage(pool, conversationId, {
    role: 'assistant',
    content: 'Recording that decision.',
    toolCallId,
    toolName: 'manage_substrate',
    toolArgs: proposeArgs,
    toolResult: null,
    modelUsed: 'claude-sonnet-4-5',
  });

  const approval = await createSubstrateEscalationApproval(pool, {
    conversationId,
    pausedMessageId: assistant.id,
    actionId: ACTION_ID,
  });

  return { conversationId, toolCallId, approval: approval! };
}

function toolRow(messages: Message[]): Message | undefined {
  return messages.find((m) => m.role === 'tool');
}

function actionsCalled(): string[] {
  return mockCallMcpTool.mock.calls.map((c) => (c[1] as { action?: string } | undefined)?.action ?? '');
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Substrate's ledger, as far as these tests need it: exactly one transition
 * per action. Whichever of approve/reject lands FIRST wins; the other gets the
 * error `rejectAction`/`approveAction` actually throw.
 */
function substrateLedger(gate: { approve?: Promise<void>; reject?: Promise<void> }) {
  let winner: 'approve' | 'reject' | null = null;
  mockCallMcpTool.mockImplementation((async (_name: string, args: Record<string, unknown>) => {
    const action = args.action as 'approve' | 'reject';
    // The ledger row is claimed on ARRIVAL (substrate takes `FOR UPDATE`
    // first thing); the gate below only delays the response, standing in for a
    // slow execute or a lost reply.
    const won = winner === null;
    if (won) winner = action;
    const wait = action === 'approve' ? gate.approve : gate.reject;
    if (wait) await wait;
    if (won) {
      return mcpEnvelope({
        action_id: ACTION_ID,
        status: action === 'approve' ? 'executed' : 'rejected',
      });
    }
    return mcpEnvelope(
      { error: `action is not in proposed state (status=${winner === 'approve' ? 'executed' : 'rejected'})` },
      true,
    );
  }) as never);
  return { winner: () => winner };
}

/** Poll until `predicate` holds, so the race is sequenced rather than timed. */
async function until(predicate: () => boolean, label: string) {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

/**
 * Same, but never throws. Used where the BROKEN implementation would block
 * (the second leg waits on the advisory lock and never reaches substrate at
 * all), so that the test goes on to fail on the defect itself — a leg
 * reporting a result for a call it never made — rather than on a hang.
 */
async function softly(predicate: () => boolean) {
  for (let i = 0; i < 60; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('I-1 — a deny racing an approve cannot report a fabricated success', () => {
  it('makes its OWN reject call and records substrate\'s real answer, not the approve\'s cached envelope', async () => {
    const { conversationId, approval } = await escalate();

    // The approve is held open inside `executeOnce` — it holds the advisory
    // lock for the duration. That is precisely the window in which the old
    // code served the deny out of the approve's cache.
    const approveGate = deferred<void>();
    const ledger = substrateLedger({ approve: approveGate.promise });

    const approvePromise = resolveOperatorApproval(pool, {
      approvalId: approval.id,
      orgId: ORG,
      jwt: 'jwt-token',
      userId: USER,
      resolution: { status: 'approved' },
    });
    await until(() => actionsCalled().includes('approve'), 'the approve to reach substrate');

    let denyDone = false;
    const denyPromise = resolveOperatorApproval(pool, {
      approvalId: approval.id,
      orgId: ORG,
      jwt: 'jwt-token',
      userId: USER,
      resolution: { status: 'denied', reason: 'not our call to make' },
    }).then((r) => {
      denyDone = true;
      return r;
    });
    // The deny must reach substrate on its own. Under the old code it blocked
    // on the advisory lock instead, and once released read the approve's
    // cached envelope — so this never became true and the assertions below
    // fail on the fabrication rather than on a hang.
    await softly(() => denyDone);

    approveGate.resolve();
    const [denyOutcome, approveOutcome] = await Promise.all([denyPromise, approvePromise]);

    // BOTH legs made their own call. The old code made exactly ONE.
    expect(mockCallMcpTool).toHaveBeenCalledTimes(2);
    expect(actionsCalled().sort()).toEqual(['approve', 'reject']);

    // Substrate arbitrated: the approve arrived first, so the reject lost.
    expect(ledger.winner()).toBe('approve');

    // The deny won the conditional UPDATE, and it told the truth about the
    // far side. The old code recorded `substrate_action_rejected: true` here —
    // for an action substrate had EXECUTED, on the strength of a reject call
    // it never made.
    expect(denyOutcome).toEqual({ ok: true });
    expect(approveOutcome).toEqual({ ok: false, code: 409, error: 'approval already resolved' });

    const resolved = (await getApprovalForOrg(pool, approval.id, ORG))!;
    expect(resolved.status).toBe('denied');

    const messages = await listMessages(pool, conversationId);
    const row = toolRow(messages)!.toolResult as Record<string, unknown>;
    expect(row.substrate_action_rejected).toBe(false);
    expect(String(row.substrate_reject_error)).toContain('not in proposed state');

    // The winning call still executed exactly once, and is the only thing in
    // the idempotency ledger under this approval.
    const rows = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM dashboard_agent_tool_executions WHERE approval_id = $1`,
      [approval.id],
    );
    expect(rows.rows[0].n).toBe(1);
    const cached = await pool.query<{ result: { result?: { content?: { text: string }[] } } }>(
      `SELECT result FROM dashboard_agent_tool_executions WHERE approval_id = $1`,
      [approval.id],
    );
    expect(cached.rows[0].result.result?.content?.[0].text).toContain('executed');
  });

  it('an approve racing a deny issues its own approve call rather than reading the reject\'s result', async () => {
    // The mirror image. Under the old code the deny executed first, cached
    // `{ status: "rejected" }` under the approval id, and the approve was
    // handed that envelope — the transcript then said the action was REJECTED
    // on a turn the dashboard recorded as APPROVED.
    const { conversationId, approval } = await escalate();

    const rejectGate = deferred<void>();
    const ledger = substrateLedger({ reject: rejectGate.promise });

    const denyPromise = resolveOperatorApproval(pool, {
      approvalId: approval.id,
      orgId: ORG,
      jwt: 'jwt-token',
      userId: USER,
      resolution: { status: 'denied', reason: 'no' },
    });
    await until(() => actionsCalled().includes('reject'), 'the deny to reach substrate');

    let approveDone = false;
    const approvePromise = resolveOperatorApproval(pool, {
      approvalId: approval.id,
      orgId: ORG,
      jwt: 'jwt-token',
      userId: USER,
      resolution: { status: 'approved' },
    }).then((r) => {
      approveDone = true;
      return r;
    });
    // Under the old code the approve blocked on the advisory lock the deny's
    // `executeOnce` was holding, and once released was served the deny's
    // cached result. Soft, so the assertions below judge the fabrication.
    await softly(() => approveDone);

    rejectGate.resolve();
    await Promise.all([approvePromise, denyPromise]);

    expect(mockCallMcpTool).toHaveBeenCalledTimes(2);
    expect(actionsCalled().sort()).toEqual(['approve', 'reject']);
    // The deny arrived first, so substrate rejected the action and refused the
    // approve. The approve leg gets THAT answer, from a call it actually made.
    expect(ledger.winner()).toBe('reject');

    // The transcript carries substrate's real answer to the APPROVE. The old
    // code put the deny's cached `{ status: "rejected" }` SUCCESS payload here
    // — a turn told its own propose had been rejected by a call it never made.
    const messages = await listMessages(pool, conversationId);
    const text = JSON.stringify(toolRow(messages)!.toolResult);
    expect(text).toContain('not in proposed state');
    expect(text).not.toContain('"status":"rejected"');

    // NOTE, and deliberately NOT pinned as correct: the approve leg does not
    // inspect the MCP tool-level `isError` flag on the non-bridging path, so a
    // refused approve still resolves the row as 'approved' with the error in
    // the transcript. That is a separate defect from I-1 (it is about envelope
    // semantics, not the cache key) and is recorded in the fix report.
  });
});

describe('I-1 — exactly-once is preserved for the call that does own the key', () => {
  it('serves a RETRIED approve of the same approval from the cache', async () => {
    const { approval } = await escalate();
    substrateLedger({});

    const first = await resolveOperatorApproval(pool, {
      approvalId: approval.id, orgId: ORG, jwt: 'jwt-token', userId: USER,
      resolution: { status: 'approved' },
    });
    expect(first).toEqual({ ok: true });

    // A retry 409s at the approval row, so drive `executeOnce` directly to
    // prove the CACHE — not the status guard — is what stops a second call.
    const { executeOnce } = await import('../../services/dashboard-agent/tool-bridge.js');
    const replay = await executeOnce(pool, {
      approvalId: approval.id,
      name: 'manage_substrate',
      args: { action: 'approve', action_id: ACTION_ID },
      jwt: 'jwt-token',
      orgId: ORG,
      principal: 'human',
    });

    expect(mockCallMcpTool).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(replay)).toContain('executed');
  });

  it('does not cache a FAILED approve — a transient error stays retryable', async () => {
    const { approval } = await escalate();
    mockCallMcpTool.mockResolvedValue({ ok: false, error: 'substrate unreachable' } as never);

    const first = await resolveOperatorApproval(pool, {
      approvalId: approval.id, orgId: ORG, jwt: 'jwt-token', userId: USER,
      resolution: { status: 'approved' },
    });
    expect(first).toEqual({ ok: false, code: 502, error: 'Tool execution failed: substrate unreachable' });

    const rows = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM dashboard_agent_tool_executions WHERE approval_id = $1`,
      [approval.id],
    );
    expect(rows.rows[0].n).toBe(0);

    // Still pending, so the retry re-attempts the call rather than replaying.
    expect((await getApprovalForOrg(pool, approval.id, ORG))!.status).toBe('pending');
    mockCallMcpTool.mockResolvedValue(mcpEnvelope({ action_id: ACTION_ID, status: 'executed' }) as never);
    const retry = await resolveOperatorApproval(pool, {
      approvalId: approval.id, orgId: ORG, jwt: 'jwt-token', userId: USER,
      resolution: { status: 'approved' },
    });
    expect(retry).toEqual({ ok: true });
    expect(mockCallMcpTool).toHaveBeenCalledTimes(2);
  });
});
